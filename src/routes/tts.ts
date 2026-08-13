/** POST /tts — OpenAI(gpt-4o-mini-tts) で音声合成し、KV/R2 キャッシュを介して返す（callable 互換）。 */
import { verifySessionToken } from '../lib/auth/session';
import {
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import { bytesToBase64, sha256Hex } from '../lib/crypto';
import { synthesizeSpeech, type TtsOptions } from '../lib/openai/tts';
import { writeTtsCache } from '../lib/ttsCache';
import type { Env } from '../types';
import { normalizeRomanText } from '../utils/normalize';
import { stripSsml, utf8ByteLength } from '../utils/ssml';
import { resolveOpenAiVoiceName, resolveTtsModel } from '../utils/ttsVoice';

interface TtsRequest {
  textJa?: unknown;
  textEn?: unknown;
  model?: unknown;
  jaVoiceName?: unknown;
  enVoiceName?: unknown;
  instructionsJa?: unknown;
  instructionsEn?: unknown;
}

interface TtsConfig {
  model?: string;
  jaVoiceName?: string;
  enVoiceName?: string;
  instructionsJa?: string;
  instructionsEn?: string;
}

interface VoiceCacheMeta {
  pathJa?: string;
  pathEn?: string;
  jaAudioMimeType?: string;
  enAudioMimeType?: string;
}

const TEXT_BYTE_LIMIT = 4000;
// 読み方の指示は声色の調整用で、長文を受ける必要はない。無制限に受けると
// リクエストサイズとキャッシュキーが無駄に膨らむため上限を設ける。
const INSTRUCTIONS_BYTE_LIMIT = 2000;
const HASH_VERSION = 13;
const TTS_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

let ttsConfigCache: { data: TtsConfig; fetchedAt: number } | null = null;

const getTtsConfig = async (env: Env): Promise<TtsConfig> => {
  if (
    ttsConfigCache &&
    Date.now() - ttsConfigCache.fetchedAt < TTS_CONFIG_CACHE_TTL_MS
  ) {
    return ttsConfigCache.data;
  }
  try {
    const data = (await env.TTS_KV.get<TtsConfig>('config:tts', 'json')) ?? {};
    ttsConfigCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    if (ttsConfigCache) return ttsConfigCache.data;
    console.warn('Failed to read tts config from KV:', e);
    return {};
  }
};

const computeId = async (payload: {
  enVoiceName: string;
  instructionsEn: string;
  instructionsJa: string;
  jaVoiceName: string;
  model: string;
  textEn: string;
  textJa: string;
  ttsOptions: TtsOptions;
}): Promise<string> => {
  const obj = { ...payload, version: HASH_VERSION } as const;
  const hashPayload = JSON.stringify(obj, Object.keys(obj).sort());
  return sha256Hex(hashPayload);
};

/**
 * 読み上げ対象テキストを受け取り、検証済みのプレーンテキストを返す。
 * 未指定・空文字は「その言語を要求しない」を意味する（合成は文字数課金のため、
 * アプリはユーザーが無効にしている言語を送ってこない）。
 */
export const parseTtsText = (value: unknown, name: string): string => {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new CallableError(
      'invalid-argument',
      `"${name}" must be a string if provided`
    );
  }
  // gpt-4o-mini-tts は SSML を解釈せずタグをそのまま読み上げるため、万一
  // タグが紛れ込んでも読ませない。プレーンテキストには実質作用しない。
  const stripped = stripSsml(value).trim();
  if (stripped.length === 0) {
    return '';
  }

  const bytes = utf8ByteLength(stripped);
  if (bytes > TEXT_BYTE_LIMIT) {
    throw new CallableError(
      'invalid-argument',
      `${name} exceeds ${TEXT_BYTE_LIMIT} byte limit (${bytes} bytes)`
    );
  }
  return stripped;
};

/** 読み方の指示を リクエスト → KV 設定 → 環境変数 の順で解決する。 */
export const resolveInstructions = (
  requested: unknown,
  configured: string | undefined,
  fallback: string | undefined
): string => {
  const value =
    typeof requested === 'string' && requested.trim().length > 0
      ? requested.trim()
      : configured?.trim() || fallback?.trim() || '';
  if (!value) {
    return '';
  }
  // 上限超過は弾かずに切り詰める。読み方の指示は本文ではないため、
  // これだけで放送そのものを失敗させる必要はない。
  return utf8ByteLength(value) > INSTRUCTIONS_BYTE_LIMIT
    ? value.slice(0, INSTRUCTIONS_BYTE_LIMIT)
    : value;
};

export const handleTts = async (
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  await verifySessionToken(env, req.headers.get('Authorization'));

  const data = await parseCallableData<TtsRequest>(req);

  const textJa = parseTtsText(data.textJa, 'textJa');
  // 英語は駅名の表記ゆれ（全角記号・略記・長音符・大文字表記）を吸収してから合成する
  const textEn = normalizeRomanText(parseTtsText(data.textEn, 'textEn')).trim();

  const wantsJa = textJa.length > 0;
  const wantsEn = textEn.length > 0;
  if (!wantsJa && !wantsEn) {
    throw new CallableError(
      'invalid-argument',
      'The function must be called with at least one of "textJa" or "textEn" containing the text to speak.'
    );
  }

  if (!env.OPENAI_API_KEY) {
    throw new CallableError(
      'failed-precondition',
      'OPENAI_API_KEY is not configured'
    );
  }

  const ttsConfig = await getTtsConfig(env);
  const model = resolveTtsModel(data.model, ttsConfig.model, env.TTS_MODEL);
  const jaVoiceName = resolveOpenAiVoiceName(
    data.jaVoiceName,
    ttsConfig.jaVoiceName,
    env.TTS_JA_VOICE_NAME
  );
  const enVoiceName = resolveOpenAiVoiceName(
    data.enVoiceName,
    ttsConfig.enVoiceName,
    env.TTS_EN_VOICE_NAME
  );
  const instructionsJa = resolveInstructions(
    data.instructionsJa,
    ttsConfig.instructionsJa,
    env.TTS_INSTRUCTIONS_JA
  );
  const instructionsEn = resolveInstructions(
    data.instructionsEn,
    ttsConfig.instructionsEn,
    env.TTS_INSTRUCTIONS_EN
  );

  // 合成オプションもキャッシュキーに含める（responseFormat/speed を変えたら
  // 別の音声になるため、同じ voice:${id} を再利用させない）。
  const ttsOptions: TtsOptions = {
    responseFormat: env.TTS_RESPONSE_FORMAT || undefined,
    speed: env.TTS_SPEED || undefined,
  };

  const id = await computeId({
    enVoiceName,
    instructionsEn,
    instructionsJa,
    jaVoiceName,
    model,
    textEn,
    textJa,
    ttsOptions,
  });

  // --- キャッシュ照会 ---
  // id は「どの言語を要求したか」まで含めて決まるため、要求した言語のパスが
  // 揃っていれば同じ組み合わせの再放送とみなせる。
  const meta = await env.TTS_KV.get<VoiceCacheMeta>(`voice:${id}`, 'json');
  if (meta && (!wantsJa || meta.pathJa) && (!wantsEn || meta.pathEn)) {
    try {
      const [jaObj, enObj] = await Promise.all([
        wantsJa && meta.pathJa ? env.TTS_BUCKET.get(meta.pathJa) : null,
        wantsEn && meta.pathEn ? env.TTS_BUCKET.get(meta.pathEn) : null,
      ]);
      if ((!wantsJa || jaObj) && (!wantsEn || enObj)) {
        const [jaBuf, enBuf] = await Promise.all([
          jaObj ? jaObj.arrayBuffer() : null,
          enObj ? enObj.arrayBuffer() : null,
        ]);
        return callableSuccess({
          id,
          ...(jaBuf
            ? {
                jaAudioContent: bytesToBase64(jaBuf),
                jaAudioMimeType: meta.jaAudioMimeType ?? 'audio/mpeg',
              }
            : {}),
          ...(enBuf
            ? {
                enAudioContent: bytesToBase64(enBuf),
                enAudioMimeType: meta.enAudioMimeType ?? 'audio/mpeg',
              }
            : {}),
        });
      }
    } catch (e) {
      console.warn(
        'Cache hit but R2 read failed. Falling back to synthesis.',
        e
      );
    }
  }

  // --- 合成（OpenAI） ---
  // 要求された言語だけ合成する（合成は文字数課金）
  const gatewayBaseUrl = env.AI_GATEWAY_BASE_URL || undefined;
  const [jaAudio, enAudio] = await Promise.all([
    wantsJa
      ? synthesizeSpeech({
          apiKey: env.OPENAI_API_KEY,
          gatewayBaseUrl,
          model,
          voiceName: jaVoiceName,
          text: textJa,
          opts: { ...ttsOptions, instructions: instructionsJa || undefined },
        })
      : null,
    wantsEn
      ? synthesizeSpeech({
          apiKey: env.OPENAI_API_KEY,
          gatewayBaseUrl,
          model,
          voiceName: enVoiceName,
          text: textEn,
          opts: { ...ttsOptions, instructions: instructionsEn || undefined },
        })
      : null,
  ]);

  // キャッシュ書き込みは非同期（失敗してもユーザー応答に影響させない）。
  // 音声は Queues の上限(128KB)に収まらないため、キューを介さず R2+KV へ直接書く。
  ctx.waitUntil(
    writeTtsCache(
      {
        id,
        jaAudioContent: jaAudio?.audioContent,
        enAudioContent: enAudio?.audioContent,
        jaAudioMimeType: jaAudio?.mimeType,
        enAudioMimeType: enAudio?.mimeType,
        textJa,
        textEn,
        model,
        voiceJa: wantsJa ? jaVoiceName : undefined,
        voiceEn: wantsEn ? enVoiceName : undefined,
      },
      env
    ).catch((err) => console.error('Failed to cache tts audio:', err))
  );

  return callableSuccess({
    id,
    ...(jaAudio
      ? {
          jaAudioContent: jaAudio.audioContent,
          jaAudioMimeType: jaAudio.mimeType,
        }
      : {}),
    ...(enAudio
      ? {
          enAudioContent: enAudio.audioContent,
          enAudioMimeType: enAudio.mimeType,
        }
      : {}),
  });
};
