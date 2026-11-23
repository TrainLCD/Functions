import { ENGLISH_VOICE_ID, MODEL } from '../../lib/elevenlabs/tts';
import { computeAudioId, computeId } from '../../lib/ttsCacheId';
import { DEFAULT_TTS_VOICE } from '../../utils/ttsVoice';
import type { VoiceCacheRecord } from './wrangler';

export function migrationSettings(
  jaVoiceId: string | undefined,
  env: Record<string, string | undefined>
) {
  return {
    jaVoice: jaVoiceId || env.TTS_JA_VOICE_ID || '',
    dictionaryId: env.TTS_EN_DICTIONARY_ID?.trim(),
    dictionaryVersion: env.TTS_EN_DICTIONARY_VERSION_ID?.trim(),
  };
}

export async function verifiedCopies(
  record: VoiceCacheRecord & {
    jaAudioMimeType?: string;
    enAudioMimeType?: string;
  },
  settings: {
    jaVoice: string;
    dictionaryId?: string;
    dictionaryVersion?: string;
  }
) {
  const google = record.model === 'google-cloud-tts';
  if (!google && record.model !== MODEL) return [];
  const textJa = record.textJa ?? '';
  const textEn = record.textEn ?? '';
  if (!textJa && !textEn) return [];
  const base = {
    textJa,
    textEn,
    jaVoiceName:
      record.voiceJa ?? (google ? DEFAULT_TTS_VOICE.ja : settings.jaVoice),
    enVoiceName:
      record.voiceEn ?? (google ? DEFAULT_TTS_VOICE.en : ENGLISH_VOICE_ID),
    model: google ? 'google-cloud-tts' : MODEL,
    pitch: null,
    speed: null,
  };
  const dictionaries =
    !google && textEn && settings.dictionaryId && settings.dictionaryVersion
      ? [
          {
            enDictionaryId: settings.dictionaryId,
            enDictionaryVersionId: settings.dictionaryVersion,
          },
          {},
        ]
      : [{}];
  for (const responseFormat of ['mp3', 'wav', 'opus']) {
    for (const dictionary of dictionaries) {
      const inputs = { ...base, responseFormat, ...dictionary };
      if ((await computeId(inputs)) !== record.id) continue;
      const copies = [];
      for (const language of ['ja', 'en'] as const) {
        const ja = language === 'ja';
        const source = ja ? record.pathJa : record.pathEn;
        if (!(ja ? textJa : textEn) || !source) continue;
        const prefix = `caches/tts/${language}/`;
        const mimeType =
          (ja ? record.jaAudioMimeType : record.enAudioMimeType) ??
          'audio/mpeg';
        const legacyOpus =
          responseFormat === 'opus' && mimeType === 'audio/ogg';
        const ext = source.split('.').pop();
        if (
          !ext ||
          (!['mp3', 'wav', 'opus'].includes(ext) &&
            !(ext === 'pcm' && legacyOpus)) ||
          source !== `${prefix}${record.id}.${ext}`
        )
          continue;
        const id = await computeAudioId(inputs, language);
        if (id === record.id) continue;
        const target = `${prefix}${id}.${ext}`;
        const meta = {
          id,
          model: base.model,
          createdAt: record.createdAt,
          ...(ja
            ? {
                pathJa: target,
                textJa,
                voiceJa: base.jaVoiceName,
                jaAudioMimeType: mimeType,
              }
            : {
                pathEn: target,
                textEn,
                voiceEn: base.enVoiceName,
                enAudioMimeType: mimeType,
              }),
        };
        copies.push({ id, source, target, mimeType, meta });
      }
      return copies;
    }
  }
  return [];
}
