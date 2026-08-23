/** POST /tts — Google Cloud TTS で音声合成し、KV/R2 キャッシュを介して返す（callable 互換）。 */
import { verifySessionToken } from '../lib/auth/session';
import {
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import { bytesToBase64, sha256Hex } from '../lib/crypto';
import {
  normalizeResponseFormat,
  parsePitch,
  parseSpeed,
  synthesizeSpeech,
  type TtsOptions,
} from '../lib/google/tts';
import { writeTtsCache } from '../lib/ttsCache';
import type { Env } from '../types';
import { normalizeRomanText } from '../utils/normalize';
import { stripSsml, utf8ByteLength } from '../utils/ssml';
import {
  languageCodeFromVoiceName,
  resolveGoogleVoiceName,
} from '../utils/ttsVoice';

/**
 * model / instructions* は OpenAI(gpt-4o-mini-tts) 時代のフィールド。Cloud TTS の
 * Standard 系ボイスにはモデル指定も読み方のプロンプト指示も無いため受け取っても
 * 使わないが、旧バージョンのアプリが送ってきても壊れないよう型としては残す。
 */
interface TtsRequest {
  textJa?: unknown;
  textEn?: unknown;
  jaVoiceName?: unknown;
  enVoiceName?: unknown;
}

interface TtsConfig {
  jaVoiceName?: string;
  enVoiceName?: string;
}

/** キャッシュメタに残す合成エンジン名（find-tts-cache の表示用）。 */
const TTS_ENGINE = 'google-cloud-tts';

interface VoiceCacheMeta {
  pathJa?: string;
  pathEn?: string;
  jaAudioMimeType?: string;
  enAudioMimeType?: string;
}

const TEXT_BYTE_LIMIT = 4000;
// 合成エンジンの入れ替え（OpenAI → Google Cloud TTS）で同じ入力でも音声が変わるため、
// 旧キャッシュへヒットしないよう版を上げる
const HASH_VERSION = 14;
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

// JSON.stringify の第2引数に配列を渡すと「その名前のキーだけ」を全階層で
// 直列化する。ネストしたオプションは名前がリストに無いと丸ごと落ちるため、
// キャッシュキーへ含めたい値はすべてトップレベルへ平坦化して渡すこと。
export const computeId = async (payload: {
  enVoiceName: string;
  jaVoiceName: string;
  pitch: number | null;
  responseFormat: string;
  speed: number | null;
  textEn: string;
  textJa: string;
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
  // Cloud TTS の input.text は SSML を解釈せずタグをそのまま読み上げるため、万一
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

  if (!env.GOOGLE_TTS_SA_KEY) {
    throw new CallableError(
      'failed-precondition',
      'GOOGLE_TTS_SA_KEY is not configured'
    );
  }

  const ttsConfig = await getTtsConfig(env);
  const jaVoiceName = resolveGoogleVoiceName(
    data.jaVoiceName,
    ttsConfig.jaVoiceName,
    env.TTS_JA_VOICE_NAME,
    'ja'
  );
  const enVoiceName = resolveGoogleVoiceName(
    data.enVoiceName,
    ttsConfig.enVoiceName,
    env.TTS_EN_VOICE_NAME,
    'en'
  );

  // 環境変数は文字列なので、送信前に正規化した値を作る。この正規化後の値を
  // そのままキャッシュキーにも使い、設定変更が確実に別 ID になるようにする。
  const responseFormat = normalizeResponseFormat(env.TTS_RESPONSE_FORMAT);
  const speed = parseSpeed(env.TTS_SPEED);
  const pitch = parsePitch(env.TTS_PITCH);
  const ttsOptions: TtsOptions = { responseFormat, speed, pitch };

  const id = await computeId({
    enVoiceName,
    jaVoiceName,
    pitch: pitch ?? null,
    responseFormat,
    speed: speed ?? null,
    textEn,
    textJa,
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

  // --- 合成（Google Cloud TTS） ---
  // 要求された言語だけ合成する（合成は文字数課金）
  const [jaAudio, enAudio] = await Promise.all([
    wantsJa
      ? synthesizeSpeech({
          saKeyJson: env.GOOGLE_TTS_SA_KEY,
          languageCode: languageCodeFromVoiceName(jaVoiceName),
          voiceName: jaVoiceName,
          text: textJa,
          opts: ttsOptions,
        })
      : null,
    wantsEn
      ? synthesizeSpeech({
          saKeyJson: env.GOOGLE_TTS_SA_KEY,
          languageCode: languageCodeFromVoiceName(enVoiceName),
          voiceName: enVoiceName,
          text: textEn,
          opts: ttsOptions,
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
        model: TTS_ENGINE,
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
