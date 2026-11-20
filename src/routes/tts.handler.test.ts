import { verifySessionToken } from '../lib/auth/session';
import { synthesizeSpeech } from '../lib/elevenlabs/tts';
import { writeTtsCache } from '../lib/ttsCache';
import type { Env } from '../types';
import { computeId, handleTts } from './tts';

jest.mock('../lib/auth/session', () => ({ verifySessionToken: jest.fn() }));
jest.mock('../lib/ttsCache', () => ({ writeTtsCache: jest.fn() }));
jest.mock('../lib/elevenlabs/tts', () => ({
  ...jest.requireActual('../lib/elevenlabs/tts'),
  synthesizeSpeech: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(verifySessionToken).mockResolvedValue({ sub: 'test' } as never);
  jest.mocked(synthesizeSpeech).mockResolvedValue({
    audioContent: 'AQID',
    mimeType: 'audio/mpeg',
  });
  jest.mocked(writeTtsCache).mockResolvedValue();
});

it.each(['miss', 'hit', 'r2-failure'])(
  'uses Imogen despite old overrides on a cache %s',
  async (cacheState) => {
    const expectedId = await computeId({
      enVoiceName: 'jv41DhCf464zw0TI7I1w',
      jaVoiceName: 'japanese-voice',
      pitch: null,
      speed: null,
      responseFormat: 'mp3',
      textEn: 'Keisei, Seibu, Mine, Takamine, Minezaki.',
      textJa: '',
    });
    const get = jest.fn(async (key: string) =>
      key === 'config:tts'
        ? { enVoiceId: 'old-male-voice' }
        : cacheState === 'miss'
          ? null
          : { pathEn: 'en.mp3' }
    );
    const bucketGet = jest.fn(async () => {
      if (cacheState === 'r2-failure') throw new Error('R2 unavailable');
      return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    });
    const env = {
      ELEVENLABS_API_KEY: 'test',
      TTS_JA_VOICE_ID: 'japanese-voice',
      TTS_EN_VOICE_ID: 'old-environment-voice',
      TTS_SPEED: '0.7',
      TTS_KV: { get },
      TTS_BUCKET: { get: bucketGet },
    } as unknown as Env;
    const waitUntil = jest.fn();
    for (const speed of [0.85, 1.15]) {
      const response = await handleTts(
        new Request('https://example.com/tts', {
          method: 'POST',
          body: JSON.stringify({
            data: {
              textEn: 'Keisei, Seibu, Mine, Takamine, Minezaki.',
              enVoiceName: 'male',
              speed,
            },
          }),
        }),
        env,
        { waitUntil } as unknown as ExecutionContext
      );
      expect(await response.json()).toEqual({
        result: {
          id: expectedId,
          enAudioContent: 'AQID',
          enAudioMimeType: 'audio/mpeg',
        },
      });
    }
    expect(get).toHaveBeenCalledWith(`voice:${expectedId}`, 'json');
    if (cacheState === 'hit') {
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expect(writeTtsCache).not.toHaveBeenCalled();
    } else {
      expect(synthesizeSpeech).toHaveBeenCalledTimes(2);
      expect(synthesizeSpeech).toHaveBeenCalledWith({
        apiKey: 'test',
        languageCode: 'en',
        voiceName: 'jv41DhCf464zw0TI7I1w',
        text: 'Keisei, Seibu, Mine, Takamine, Minezaki.',
        opts: { responseFormat: 'mp3' },
      });
      expect(writeTtsCache).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expectedId,
          voiceEn: 'jv41DhCf464zw0TI7I1w',
          jaAudioContent: undefined,
          textEn: 'Keisei, Seibu, Mine, Takamine, Minezaki.',
        }),
        env
      );
    }
  }
);

it('changes the cache ID by English dictionary version only for requests containing English', async () => {
  const env = {
    ELEVENLABS_API_KEY: 'test',
    TTS_JA_VOICE_ID: 'ja',
    TTS_EN_DICTIONARY_ID: 'stations',
    TTS_EN_DICTIONARY_VERSION_ID: 'v1',
    TTS_KV: { get: jest.fn().mockResolvedValue(null) },
  };
  const request = async (textEn: string) => {
    const response = await handleTts(
      new Request('https://example.com/tts', {
        method: 'POST',
        body: JSON.stringify({ data: { textJa: '次は', textEn } }),
      }),
      env as unknown as Env,
      { waitUntil: jest.fn() } as unknown as ExecutionContext
    );
    return ((await response.json()) as { result: { id: string } }).result.id;
  };
  const ja = await request('');
  const both = await request('Mine');
  expect(synthesizeSpeech).toHaveBeenLastCalledWith(
    expect.objectContaining({
      languageCode: 'en',
      dictionary: { pronunciationDictionaryId: 'stations', versionId: 'v1' },
    })
  );
  env.TTS_EN_DICTIONARY_VERSION_ID = 'v2';
  expect(await request('')).toBe(ja);
  expect(await request('Mine')).not.toBe(both);
  env.TTS_EN_DICTIONARY_VERSION_ID = '';
  await expect(request('Mine')).rejects.toThrow('must be configured together');
});
