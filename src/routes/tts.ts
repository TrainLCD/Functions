/** POST /tts — Azure Speech で音声合成し、KV/R2 キャッシュを介して返す（callable 互換）。 */
import { verifySessionToken } from '../lib/auth/session';
import { synthesizeSpeech, type TtsOptions } from '../lib/azure/tts';
import {
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import { bytesToBase64, sha256Hex } from '../lib/crypto';
import { writeTtsCache } from '../lib/ttsCache';
import type { Env } from '../types';
import { normalizeRomanText } from '../utils/normalize';
import { stripSsml, utf8ByteLength } from '../utils/ssml';
import { resolveAzureVoiceName } from '../utils/ttsVoice';

interface TtsRequest {
  ssmlJa?: unknown;
  ssmlEn?: unknown;
  jaVoiceName?: unknown;
  enVoiceName?: unknown;
}

interface TtsConfig {
  jaVoiceName?: string;
  enVoiceName?: string;
}

interface VoiceCacheMeta {
  pathJa?: string;
  pathEn?: string;
  jaAudioMimeType?: string;
  enAudioMimeType?: string;
}

const TEXT_BYTE_LIMIT = 4000;
const RAW_SSML_BYTE_LIMIT = 10000;
const HASH_VERSION = 12;
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
  jaVoiceName: string;
  ssmlEn: string;
  ssmlJa: string;
  ttsOptions: TtsOptions;
}): Promise<string> => {
  const obj = { ...payload, version: HASH_VERSION } as const;
  const hashPayload = JSON.stringify(obj, Object.keys(obj).sort());
  return sha256Hex(hashPayload);
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CallableError(
      'invalid-argument',
      `The function must be called with one argument "${name}" containing the message to add.`
    );
  }
  return value;
};

export const handleTts = async (
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  await verifySessionToken(env, req.headers.get('Authorization'));

  const data = await parseCallableData<TtsRequest>(req);

  const ssmlJa = requireString(data.ssmlJa, 'ssmlJa');
  // 生入力を保持し、バイト数上限は正規化前の値で判定する（正規化での展開/削除で
  // 本来通る入力を弾いたり、上限超え入力を通したりしないため）。
  const rawSsmlEn = requireString(data.ssmlEn, 'ssmlEn');
  const ssmlEn = normalizeRomanText(rawSsmlEn);
  if (ssmlEn.trim().length === 0) {
    throw new CallableError(
      'invalid-argument',
      'The function must be called with one argument "ssmlEn" containing the message to add.'
    );
  }

  const ttsConfig = await getTtsConfig(env);
  const jaVoiceName = resolveAzureVoiceName(
    data.jaVoiceName,
    ttsConfig.jaVoiceName,
    env.TTS_JA_VOICE_NAME
  );
  const enVoiceName = resolveAzureVoiceName(
    data.enVoiceName,
    ttsConfig.enVoiceName,
    env.TTS_EN_VOICE_NAME
  );

  const strippedJa = stripSsml(ssmlJa);
  const strippedEn = stripSsml(ssmlEn);
  if (strippedJa.trim().length === 0) {
    throw new CallableError(
      'invalid-argument',
      'ssmlJa contains no visible text after stripping SSML tags'
    );
  }
  if (strippedEn.trim().length === 0) {
    throw new CallableError(
      'invalid-argument',
      'ssmlEn contains no visible text after stripping SSML tags'
    );
  }

  const jaTextBytes = utf8ByteLength(strippedJa);
  const enTextBytes = utf8ByteLength(strippedEn);
  if (jaTextBytes > TEXT_BYTE_LIMIT) {
    throw new CallableError(
      'invalid-argument',
      `ssmlJa text exceeds ${TEXT_BYTE_LIMIT} byte limit (${jaTextBytes} bytes)`
    );
  }
  if (enTextBytes > TEXT_BYTE_LIMIT) {
    throw new CallableError(
      'invalid-argument',
      `ssmlEn text exceeds ${TEXT_BYTE_LIMIT} byte limit (${enTextBytes} bytes)`
    );
  }

  // 可視テキストだけでなく生 SSML のバイト長にも上限を設け、タグ膨張入力を弾く
  if (
    utf8ByteLength(ssmlJa) > RAW_SSML_BYTE_LIMIT ||
    utf8ByteLength(rawSsmlEn) > RAW_SSML_BYTE_LIMIT
  ) {
    throw new CallableError(
      'invalid-argument',
      `raw SSML exceeds ${RAW_SSML_BYTE_LIMIT} byte limit`
    );
  }

  // 合成オプションもキャッシュキーに含める（outputFormat/style/styleDegree/pitch を
  // 変えたら別の音声になるため、同じ voice:${id} を再利用させない）。
  const ttsOptions: TtsOptions = {
    outputFormat: env.AZURE_TTS_OUTPUT_FORMAT || undefined,
    style: env.AZURE_TTS_STYLE || undefined,
    styleDegree: env.AZURE_TTS_STYLE_DEGREE || undefined,
    pitch: env.AZURE_TTS_PITCH || undefined,
  };

  const id = await computeId({
    enVoiceName,
    jaVoiceName,
    ssmlEn,
    ssmlJa,
    ttsOptions,
  });

  // --- キャッシュ照会 ---
  const meta = await env.TTS_KV.get<VoiceCacheMeta>(`voice:${id}`, 'json');
  if (meta?.pathJa && meta.pathEn) {
    try {
      const [jaObj, enObj] = await Promise.all([
        env.TTS_BUCKET.get(meta.pathJa),
        env.TTS_BUCKET.get(meta.pathEn),
      ]);
      if (jaObj && enObj) {
        const [jaBuf, enBuf] = await Promise.all([
          jaObj.arrayBuffer(),
          enObj.arrayBuffer(),
        ]);
        return callableSuccess({
          id,
          jaAudioContent: bytesToBase64(jaBuf),
          enAudioContent: bytesToBase64(enBuf),
          jaAudioMimeType: meta.jaAudioMimeType ?? 'audio/mpeg',
          enAudioMimeType: meta.enAudioMimeType ?? 'audio/mpeg',
        });
      }
    } catch (e) {
      console.warn(
        'Cache hit but R2 read failed. Falling back to synthesis.',
        e
      );
    }
  }

  // --- 合成（Azure） ---
  // 音質・スタイル・プロソディは env で調整可能（ttsOptions は上で構築済み）
  const [jaAudio, enAudio] = await Promise.all([
    synthesizeSpeech(
      env.AZURE_SPEECH_REGION,
      env.AZURE_SPEECH_KEY,
      ssmlJa,
      'ja-JP',
      jaVoiceName,
      ttsOptions
    ),
    synthesizeSpeech(
      env.AZURE_SPEECH_REGION,
      env.AZURE_SPEECH_KEY,
      ssmlEn,
      'en-US',
      enVoiceName,
      ttsOptions
    ),
  ]);

  // キャッシュ書き込みは非同期（失敗してもユーザー応答に影響させない）。
  // 音声は Queues の上限(128KB)に収まらないため、キューを介さず R2+KV へ直接書く。
  ctx.waitUntil(
    writeTtsCache(
      {
        id,
        jaAudioContent: jaAudio.audioContent,
        enAudioContent: enAudio.audioContent,
        jaAudioMimeType: jaAudio.mimeType,
        enAudioMimeType: enAudio.mimeType,
        ssmlJa,
        ssmlEn,
        voiceJa: jaVoiceName,
        voiceEn: enVoiceName,
      },
      env
    ).catch((err) => console.error('Failed to cache tts audio:', err))
  );

  return callableSuccess({
    id,
    jaAudioContent: jaAudio.audioContent,
    enAudioContent: enAudio.audioContent,
    jaAudioMimeType: jaAudio.mimeType,
    enAudioMimeType: enAudio.mimeType,
  });
};
