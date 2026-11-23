/** POST /tts — 設定されたプロバイダーで音声合成し、KV/R2 キャッシュを介して返す（callable 互換）。 */
import { verifySessionToken } from '../lib/auth/session';
import {
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import { bytesToBase64, sha256Hex } from '../lib/crypto';
import { synthesizeCheckedAnnouncement } from '../lib/elevenlabs/checkedAnnouncement';
import {
  ENGLISH_VOICE_ID,
  MODEL,
  normalizeResponseFormat,
  synthesizeSpeech,
} from '../lib/elevenlabs/tts';
import { synthesizeSpeech as synthesizeGoogleSpeech } from '../lib/google/tts';
import { writeTtsCache } from '../lib/ttsCache';
import type { Env } from '../types';
import {
  applyGooglePronunciation,
  normalizeRomanText,
} from '../utils/normalize';
import { stripSsml, utf8ByteLength } from '../utils/ssml';
import {
  DEFAULT_TTS_VOICE,
  languageCodeFromVoiceName,
  type TtsLanguage,
} from '../utils/ttsVoice';

interface TtsRequest {
  textJa?: unknown;
  textEn?: unknown;
  // 旧クライアントとの互換用。合成時には使用しない。
  speed?: unknown;
}

interface TtsConfig {
  provider?: 'elevenlabs' | 'google';
  jaVoiceId?: string;
}

interface VoiceCacheMeta {
  pathJa?: string;
  pathEn?: string;
  jaAudioMimeType?: string;
  enAudioMimeType?: string;
}

const TEXT_BYTE_LIMIT = 4000;
const GOOGLE_TEXT_BYTE_LIMIT = 5000;
// 駅名・路線名タグ入りの旧音声を再利用しない。
const HASH_VERSION = 23;
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
  enDictionaryId?: string;
  enDictionaryVersionId?: string;
  enVoiceName: string;
  jaVoiceName: string;
  model: string;
  pitch: number | null;
  responseFormat: string;
  speed: number | null;
  textEn: string;
  textJa: string;
}): Promise<string> => {
  // 冒頭の車掌タグ混入を検査していない旧音声を再利用しない。
  const version = payload.textJa ? HASH_VERSION + 2 : HASH_VERSION;
  const obj = { ...payload, version } as const;
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

  validateTextByteLength(stripped, name, TEXT_BYTE_LIMIT);
  return stripped;
};

const validateTextByteLength = (text: string, name: string, limit: number) => {
  const bytes = utf8ByteLength(text);
  if (bytes > limit) {
    throw new CallableError(
      'invalid-argument',
      `${name} exceeds ${limit} byte limit (${bytes} bytes)`
    );
  }
};

const selectProvider = (env: Env, config: TtsConfig, wantsEn: boolean) => {
  const opts = {
    responseFormat: normalizeResponseFormat(env.TTS_RESPONSE_FORMAT),
  };
  if (config.provider !== 'elevenlabs') {
    const saKeyJson = env.GOOGLE_TTS_SA_KEY;
    if (!saKeyJson) {
      throw new CallableError(
        'failed-precondition',
        'GOOGLE_TTS_SA_KEY is not configured'
      );
    }
    return {
      model: 'google-cloud-tts',
      voices: DEFAULT_TTS_VOICE,
      responseFormat: opts.responseFormat,
      synthesize: (language: TtsLanguage, text: string) =>
        synthesizeGoogleSpeech({
          saKeyJson,
          languageCode: languageCodeFromVoiceName(DEFAULT_TTS_VOICE[language]),
          voiceName: DEFAULT_TTS_VOICE[language],
          text,
          opts,
        }),
    };
  }

  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new CallableError(
      'failed-precondition',
      'ELEVENLABS_API_KEY is not configured'
    );
  }

  const dictionaryId = wantsEn ? env.TTS_EN_DICTIONARY_ID?.trim() : '';
  const versionId = wantsEn ? env.TTS_EN_DICTIONARY_VERSION_ID?.trim() : '';
  if (Boolean(dictionaryId) !== Boolean(versionId)) {
    throw new CallableError(
      'failed-precondition',
      'TTS_EN_DICTIONARY_ID and TTS_EN_DICTIONARY_VERSION_ID must be configured together'
    );
  }
  const dictionary =
    dictionaryId && versionId
      ? { pronunciationDictionaryId: dictionaryId, versionId }
      : undefined;

  const voices = {
    ja: config.jaVoiceId || env.TTS_JA_VOICE_ID,
    en: ENGLISH_VOICE_ID,
  };
  return {
    model: MODEL,
    voices,
    responseFormat: opts.responseFormat,
    dictionary,
    synthesize: (languageCode: TtsLanguage, text: string) => {
      const params = {
        apiKey,
        languageCode,
        voiceName: voices[languageCode],
        text,
        opts,
      };
      return languageCode === 'ja'
        ? synthesizeCheckedAnnouncement(params, env.AI)
        : synthesizeSpeech({ ...params, dictionary });
    },
  };
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
  const normalizedEn = normalizeRomanText(
    parseTtsText(data.textEn, 'textEn')
  ).trim();

  const wantsJa = textJa.length > 0;
  const wantsEn = normalizedEn.length > 0;
  if (!wantsJa && !wantsEn) {
    throw new CallableError(
      'invalid-argument',
      'The function must be called with at least one of "textJa" or "textEn" containing the text to speak.'
    );
  }

  const config = await getTtsConfig(env);
  const provider = selectProvider(env, config, wantsEn);
  let textEn = normalizedEn;
  if (config.provider !== 'elevenlabs') {
    textEn = applyGooglePronunciation(normalizedEn);
    validateTextByteLength(textEn, 'textEn', GOOGLE_TEXT_BYTE_LIMIT);
  }
  const {
    model,
    responseFormat,
    dictionary,
    voices: { ja: jaVoiceName, en: enVoiceName },
  } = provider;
  const cacheInputs = {
    enDictionaryId: dictionary?.pronunciationDictionaryId,
    enDictionaryVersionId: dictionary?.versionId,
    enVoiceName,
    jaVoiceName,
    model,
    pitch: null,
    responseFormat,
    speed: null,
    textEn,
    textJa,
  };
  const id = await computeId(cacheInputs);
  if (config.provider === 'elevenlabs') {
    // Preserve the response ID and read matching legacy entries on demand.
    let legacyMeta: Promise<VoiceCacheMeta | null> | undefined;
    const resolve = async (language: TtsLanguage, text: string) => {
      if (!text) return null;
      const ja = language === 'ja';
      const audioId = await computeId({
        ...cacheInputs,
        textJa: ja ? text : '',
        textEn: ja ? '' : text,
        jaVoiceName: ja ? jaVoiceName : '',
        enVoiceName: ja ? '' : enVoiceName,
        enDictionaryId: ja ? undefined : cacheInputs.enDictionaryId,
        enDictionaryVersionId: ja
          ? undefined
          : cacheInputs.enDictionaryVersionId,
      });
      const read = async (meta: VoiceCacheMeta | null) => {
        const path = ja ? meta?.pathJa : meta?.pathEn;
        if (!path) return null;
        try {
          const obj = await env.TTS_BUCKET.get(path);
          if (!obj) return null;
          return {
            audioContent: bytesToBase64(await obj.arrayBuffer()),
            mimeType:
              (ja ? meta?.jaAudioMimeType : meta?.enAudioMimeType) ??
              'audio/mpeg',
          };
        } catch (err) {
          console.warn('Failed to read cached TTS audio:', err);
          return null;
        }
      };
      const cached = await read(
        await env.TTS_KV.get<VoiceCacheMeta>(`voice:${audioId}`, 'json')
      );
      if (cached) return cached;
      legacyMeta ??= env.TTS_KV.get<VoiceCacheMeta>(`voice:${id}`, 'json');
      const legacy = await read(await legacyMeta);
      const audio = legacy ?? (await provider.synthesize(language, text));
      ctx.waitUntil(
        writeTtsCache(
          {
            id: audioId,
            model,
            ...(ja
              ? {
                  textJa: text,
                  voiceJa: jaVoiceName,
                  jaAudioContent: audio.audioContent,
                  jaAudioMimeType: audio.mimeType,
                }
              : {
                  textEn: text,
                  voiceEn: enVoiceName,
                  enAudioContent: audio.audioContent,
                  enAudioMimeType: audio.mimeType,
                }),
          },
          env
        ).catch((err) => console.error('Failed to cache tts audio:', err))
      );
      return audio;
    };
    // Let both languages schedule their successful writes even if one fails.
    const [ja, en] = await Promise.allSettled([
      resolve('ja', textJa),
      resolve('en', textEn),
    ]);
    if (ja.status === 'rejected') throw ja.reason;
    if (en.status === 'rejected') throw en.reason;
    return callableSuccess({
      id,
      ...(ja.value && {
        jaAudioContent: ja.value.audioContent,
        jaAudioMimeType: ja.value.mimeType,
      }),
      ...(en.value && {
        enAudioContent: en.value.audioContent,
        enAudioMimeType: en.value.mimeType,
      }),
    });
  }

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

  const [jaAudio, enAudio] = await Promise.all([
    wantsJa ? provider.synthesize('ja', textJa) : null,
    wantsEn ? provider.synthesize('en', textEn) : null,
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
