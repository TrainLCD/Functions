import { ENGLISH_VOICE_ID, MODEL } from '../../lib/elevenlabs/tts';
import { computeAudioId, computeId } from '../../lib/ttsCacheId';
import { DEFAULT_TTS_VOICE } from '../../utils/ttsVoice';
import { migrationSettings, verifiedCopies } from './legacyTts';

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

it.each([
  ['', ' ja-dict ', ' v1 ', 'env-voice', 'ja-dict', 'v1'],
  ['kv-voice', 'ja-dict', 'v1', 'kv-voice', 'ja-dict', 'v1'],
  [undefined, undefined, undefined, 'env-voice', undefined, undefined],
])(
  'reconstructs the English-only legacy ID using KV voice %s and dictionary %s',
  async (
    kvVoice,
    dictionaryId,
    version,
    jaVoice,
    expectedId,
    expectedVersion
  ) => {
    const settings = migrationSettings(kvVoice, {
      TTS_JA_VOICE_ID: 'env-voice',
      TTS_EN_DICTIONARY_ID: dictionaryId,
      TTS_EN_DICTIONARY_VERSION_ID: version,
    });
    const inputs = {
      model: MODEL,
      jaVoiceName: jaVoice ?? '',
      enVoiceName: ENGLISH_VOICE_ID,
      textJa: '',
      textEn: 'Next',
      responseFormat: 'mp3',
      speed: null,
      pitch: null,
      enDictionaryId: expectedId,
      enDictionaryVersionId: expectedVersion,
    };
    const id = await computeId(inputs);
    const copies = await verifiedCopies(
      {
        id,
        model: MODEL,
        textEn: 'Next',
        voiceEn: ENGLISH_VOICE_ID,
        pathEn: `caches/tts/en/${id}.mp3`,
      },
      settings
    );
    expect(copies.map((copy) => copy.id)).toEqual([
      await computeAudioId(inputs, 'en'),
    ]);
  }
);

it.each(['google-cloud-tts', MODEL])(
  'preserves legacy Ogg Opus bytes stored with a pcm suffix for %s',
  async (model) => {
    const voices =
      model === MODEL ? { ja: 'ja', en: ENGLISH_VOICE_ID } : DEFAULT_TTS_VOICE;
    const inputs = {
      model,
      jaVoiceName: voices.ja,
      enVoiceName: voices.en,
      textJa: '次は',
      textEn: '',
      responseFormat: 'opus',
      speed: null,
      pitch: null,
    };
    const id = await computeId(inputs);
    const source = `caches/tts/ja/${id}.pcm`;
    const target = `caches/tts/ja/${await computeAudioId(inputs, 'ja')}.pcm`;
    const record = {
      id,
      model,
      textJa: inputs.textJa,
      voiceJa: voices.ja,
      pathJa: source,
      jaAudioMimeType: 'audio/ogg',
    };
    expect(await verifiedCopies(record, { jaVoice: voices.ja })).toEqual([
      expect.objectContaining({
        source,
        target,
        mimeType: 'audio/ogg',
        meta: expect.objectContaining({
          pathJa: target,
          jaAudioMimeType: 'audio/ogg',
        }),
      }),
    ]);
    expect(
      await verifiedCopies(
        { ...record, jaAudioMimeType: 'audio/pcm' },
        { jaVoice: voices.ja }
      )
    ).toEqual([]);
  }
);
