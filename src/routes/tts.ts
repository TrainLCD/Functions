/** POST /tts — Eleven v4 で音声合成し、KV/R2 キャッシュを介して返す（callable 互換）。 */
import { verifySessionToken } from '../lib/auth/session';
import {
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import { bytesToBase64, sha256Hex } from '../lib/crypto';
import {
  MODEL,
  normalizeResponseFormat,
  synthesizeSpeech,
} from '../lib/elevenlabs/tts';
import { parseClientSpeed, parseSpeed } from '../lib/google/tts';
import { writeTtsCache } from '../lib/ttsCache';
import type { Env } from '../types';
import { normalizeRomanText } from '../utils/normalize';
import { stripSsml, utf8ByteLength } from '../utils/ssml';

interface TtsRequest {
  textJa?: unknown;
  textEn?: unknown;
  // アナウンス設定で選んだ読み上げ速度。プリセット外の値は無視される
  speed?: unknown;
}

interface TtsConfig {
  jaVoiceId?: string;
  enVoiceId?: string;
}

interface VoiceCacheMeta {
  pathJa?: string;
  pathEn?: string;
  jaAudioMimeType?: string;
  enAudioMimeType?: string;
}

const TEXT_BYTE_LIMIT = 4000;
// 年齢・性別を指定していた旧車掌タグの合成結果と区別する。
const HASH_VERSION = 17;
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

  if (!env.ELEVENLABS_API_KEY) {
    throw new CallableError(
      'failed-precondition',
      'ELEVENLABS_API_KEY is not configured'
    );
  }

  const ttsConfig = await getTtsConfig(env);
  const jaVoiceName = ttsConfig.jaVoiceId || env.TTS_JA_VOICE_ID;
  const enVoiceName = ttsConfig.enVoiceId || env.TTS_EN_VOICE_ID;

  // 環境変数は文字列なので、送信前に正規化した値を作る。この正規化後の値を
  // そのままキャッシュキーにも使い、設定変更が確実に別 ID になるようにする。
  const responseFormat = normalizeResponseFormat(env.TTS_RESPONSE_FORMAT);
  // 速度はアプリの設定を優先し、未指定・プリセット外なら環境変数の既定値を使う。
  // 速度は computeId に含まれるため、選択が変わればキャッシュも自動的に分かれる。
  const configuredSpeed = parseSpeed(env.TTS_SPEED) ?? 1;
  const speed =
    parseClientSpeed(data.speed) ??
    (configuredSpeed >= 0.7 && configuredSpeed <= 1.2 ? configuredSpeed : 1);
  const ttsOptions = { responseFormat, speed };

  const id = await computeId({
    enVoiceName,
    jaVoiceName,
    pitch: null,
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

  // --- 合成（Eleven v4） ---
  // 要求された言語だけ合成する（合成は文字数課金）
  const [jaAudio, enAudio] = await Promise.all([
    wantsJa
      ? synthesizeSpeech({
          apiKey: env.ELEVENLABS_API_KEY,
          languageCode: 'ja',
          voiceName: jaVoiceName,
          text: textJa,
          opts: ttsOptions,
        })
      : null,
    wantsEn
      ? synthesizeSpeech({
          apiKey: env.ELEVENLABS_API_KEY,
          languageCode: 'en',
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
        model: MODEL,
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
