import { synthesizeSpeech } from './tts';

// Limit the comparison to words in the Japanese delivery tag. Station names
// commonly have different kana/kanji spellings in the script and transcript.
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 96))
    .replace(/[\p{P}\p{Z}\s]/gu, '')
    .replace(/つうきん/g, '通勤')
    .replace(/でんしゃ/g, '電車')
    .replace(/しゃしょう/g, '車掌')
    .replace(/こえ/g, '声');

export const hasSpokenTag = (script: string, transcript: string): boolean => {
  const prefix = normalize(transcript).match(
    /^(通勤電車|通勤|電車の車掌|車掌の声|車掌)/u
  )?.[0];
  return !!prefix && !normalize(script).startsWith(prefix);
};

export const synthesizeCheckedAnnouncement = async (
  params: Parameters<typeof synthesizeSpeech>[0],
  ai: Ai
) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const audio = await synthesizeSpeech(params);
    const result = await ai.run('@cf/openai/whisper-large-v3-turbo', {
      audio: audio.audioContent,
      language: 'ja',
      task: 'transcribe',
    });
    if (!result.text?.trim()) throw new Error('Empty Japanese TTS transcript');
    if (!hasSpokenTag(params.text, result.text)) return audio;
  }
  throw new Error('Japanese TTS repeated the delivery instruction');
};
