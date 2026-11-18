import { bytesToBase64 } from '../crypto';

export const MODEL = 'eleven_v4';

const formats = {
  mp3: ['mp3_44100_128', 'audio/mpeg'],
  wav: ['wav_24000', 'audio/wav'],
  opus: ['opus_48000_64', 'audio/ogg'],
} as const;

export const normalizeResponseFormat = (value?: string) => {
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
    speed?: number;
  };
}) => {
  const { apiKey, voiceName, languageCode, text, opts } = params;
  const [format, mimeType] = formats[opts.responseFormat];
  const url = new URL(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceName)}`
  );
  url.searchParams.set('output_format', format);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      language_code: languageCode,
      voice_settings: { speed: opts.speed ?? 1 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`ElevenLabs TTS returned ${response.status}`);
  const audio = await response.arrayBuffer();
  if (!audio.byteLength) throw new Error('ElevenLabs TTS returned empty audio');
  return { audioContent: bytesToBase64(audio), mimeType };
};
