import { bytesToBase64 } from '../crypto';
import { addLineNameTags } from './lineTags';
import { addStationNameTags } from './stationTags';

export const MODEL = 'eleven_v4';
// 英語アナウンスは Imogen（女性）に固定する。
export const ENGLISH_VOICE_ID = 'jv41DhCf464zw0TI7I1w';

const conductorVoiceTag = {
  ja: '[通勤電車の車掌の声]',
  en: '[voice of a female commuter train conductor]',
} as const;

const formats = {
  mp3: ['mp3_44100_128', 'audio/mpeg'],
  wav: ['wav_24000', 'audio/wav'],
  opus: ['opus_48000_64', 'audio/ogg'],
} as const;

export const normalizeResponseFormat = (
  value?: string
): keyof typeof formats => {
  const format = value?.trim().toLowerCase();
  return format === 'opus' || format === 'wav' ? format : 'mp3';
};

export const synthesizeSpeech = async (params: {
  apiKey: string;
  voiceName: string;
  languageCode: 'ja' | 'en';
  text: string;
  opts: {
    responseFormat: keyof typeof formats;
  };
}) => {
  const { apiKey, voiceName, languageCode, text, opts } = params;
  const speechText =
    languageCode === 'en' ? addLineNameTags(addStationNameTags(text)) : text;
  const [format, mimeType] = formats[opts.responseFormat];
  // SDK の初期化を Worker 起動時ではなく、キャッシュ未命中の合成時に行う。
  const { ElevenLabsClient, ElevenLabsError } = await import(
    '@elevenlabs/elevenlabs-js'
  );
  // Workers のシークレットをリクエストごとに渡す。
  const client = new ElevenLabsClient({ apiKey });
  let audio: ArrayBuffer;
  try {
    const stream = await client.textToSpeech.convert(
      voiceName,
      {
        text: `${conductorVoiceTag[languageCode]} ${speechText}`,
        modelId: MODEL,
        languageCode,
        outputFormat: format,
        // Eleven v4 は speed 非対応のため送信しない。
      },
      {
        // 既存の単発リクエストと、本文受信を含む30秒の期限を維持する。
        maxRetries: 0,
        timeoutInSeconds: 30,
        abortSignal: AbortSignal.timeout(30_000),
      }
    );
    audio = await new Response(stream).arrayBuffer();
  } catch (error) {
    // レスポンス全体・ヘッダー・入力本文は記録せず、診断用フィールドだけ残す。
    const sanitize = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      let safe = value;
      for (const secret of [apiKey, speechText, text]) {
        if (secret) safe = safe.split(secret).join('[REDACTED]');
      }
      return safe.slice(0, 1000);
    };
    const body = error instanceof ElevenLabsError ? error.body : undefined;
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? body.detail
        : undefined;
    const fields = detail && typeof detail === 'object' ? detail : undefined;
    console.error('ElevenLabs TTS failed', {
      model: MODEL,
      languageCode,
      voiceId: voiceName,
      outputFormat: format,
      statusCode:
        error instanceof ElevenLabsError ? error.statusCode : undefined,
      requestId:
        error instanceof ElevenLabsError
          ? sanitize(
              error.requestId ?? error.rawResponse?.headers.get('request-id')
            )
          : undefined,
      errorCode:
        fields && 'status' in fields ? sanitize(fields.status) : undefined,
      message:
        fields && 'message' in fields
          ? sanitize(fields.message)
          : sanitize(
              typeof detail === 'string'
                ? detail
                : error instanceof Error && !(error instanceof ElevenLabsError)
                  ? error.message
                  : undefined
            ),
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    if (error instanceof ElevenLabsError && error.statusCode !== undefined) {
      throw new Error(`ElevenLabs TTS returned ${error.statusCode}`);
    }
    throw error;
  }
  if (!audio.byteLength) throw new Error('ElevenLabs TTS returned empty audio');
  return { audioContent: bytesToBase64(audio), mimeType };
};
