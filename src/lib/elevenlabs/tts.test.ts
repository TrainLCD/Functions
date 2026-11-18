import { synthesizeSpeech } from './tts';

afterEach(() => {
  jest.restoreAllMocks();
});

it.each([
  ['ja', '次は、新宿です。', '[若い女性車掌の声] 次は、新宿です。'],
  [
    'en',
    'The next station is Shinjuku.',
    '[voice of a young female train conductor] The next station is Shinjuku.',
  ],
] as const)(
  'prefixes the %s announcement sent to ElevenLabs',
  async (languageCode, text, expected) => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await synthesizeSpeech({
      apiKey: 'test',
      voiceName: 'test-voice',
      languageCode,
      text,
      opts: { responseFormat: 'mp3', speed: 1.15 },
    });
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      text: expected,
      model_id: 'eleven_v4',
      language_code: languageCode,
      voice_settings: { speed: 1.15 },
    });
  }
);
