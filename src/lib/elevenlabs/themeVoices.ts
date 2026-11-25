import { ENGLISH_VOICE_ID } from './tts';

type VoicePair = { ja: string; en: string };

// Only themes with a custom voice pair need an entry here.
const themeVoices = new Map<string, VoicePair>();

export const resolveThemeVoices = (
  theme: unknown,
  defaultJa: string
): VoicePair =>
  (typeof theme === 'string' && themeVoices.get(theme)) || {
    ja: defaultJa,
    en: ENGLISH_VOICE_ID,
  };
