import { ENGLISH_VOICE_ID, MODEL } from '../../lib/elevenlabs/tts';
import { computeAudioId, computeId } from '../../lib/ttsCacheId';
import { DEFAULT_TTS_VOICE } from '../../utils/ttsVoice';
import { verifiedCopies } from './legacyTts';

it.each(['google-cloud-tts', MODEL])(
  'maps an old bilingual recording to the keys used by single-language requests for %s',
  async (model) => {
    const google = model === 'google-cloud-tts';
    const inputs = {
      model,
      textJa: '次は',
      textEn: 'Next',
      jaVoiceName: google ? DEFAULT_TTS_VOICE.ja : 'ja',
      enVoiceName: google ? DEFAULT_TTS_VOICE.en : ENGLISH_VOICE_ID,
      speed: null,
      pitch: null,
      responseFormat: 'mp3',
      ...(google
        ? {}
        : { enDictionaryId: 'stations', enDictionaryVersionId: 'v1' }),
    };
    const id = await computeId(inputs);
    const rec = {
      id,
      model,
      textJa: inputs.textJa,
      textEn: inputs.textEn,
      voiceJa: inputs.jaVoiceName,
      voiceEn: inputs.enVoiceName,
      pathJa: `caches/tts/ja/${id}.mp3`,
      pathEn: `caches/tts/en/${id}.mp3`,
    };
    const settings = {
      jaVoice: 'ja',
      dictionaryId: 'stations',
      dictionaryVersion: 'v1',
    };
    const copies = await verifiedCopies(rec, settings);
    expect(copies.map((c) => c.id)).toEqual([
      await computeAudioId(
        {
          ...inputs,
          textEn: '',
          enDictionaryId: undefined,
          enDictionaryVersionId: undefined,
        },
        'ja'
      ),
      await computeAudioId({ ...inputs, textJa: '' }, 'en'),
    ]);
    expect(copies.map((c) => c.source)).toEqual([rec.pathJa, rec.pathEn]);
    expect(
      await verifiedCopies({ ...rec, textJa: '別の原稿' }, settings)
    ).toEqual([]);
    if (!google)
      expect(
        await verifiedCopies(rec, { ...settings, dictionaryVersion: 'v2' })
      ).toEqual([]);
    expect(
      await verifiedCopies({ ...rec, pathJa: rec.pathEn }, settings)
    ).toHaveLength(1);
  }
);
