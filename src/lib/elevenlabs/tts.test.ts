import { synthesizeSpeech } from './tts';

afterEach(() => {
  jest.restoreAllMocks();
});

it.each([
  ['ja', '次はマエバシです。', '[通勤電車の車掌の声] 次はマエバシです。'],
  [
    'en',
    'The next station is Shinjuku. Please change here for the Yamanote Line.',
    '[voice of a female commuter train conductor] The next station is Shinjuku. Please change here for the Yamanote Line.',
  ],
] as const)(
  'formats the %s announcement sent to ElevenLabs',
  async (languageCode, text, expected) => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await synthesizeSpeech({
      apiKey: 'test',
      voiceName: 'test-voice',
      languageCode,
      text,
      opts: { responseFormat: 'mp3' },
    });
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({
      text: expected,
      model_id: 'eleven_v4',
      language_code: languageCode,
    });
  }
);

const params = {
  apiKey: 'test',
  voiceName: 'test-voice',
  languageCode: 'ja',
  text: '次は、新宿です。',
  opts: { responseFormat: 'mp3' },
} as const;

it.each([
  ['mp3', 'mp3_44100_128', 'audio/mpeg'],
  ['wav', 'wav_24000', 'audio/wav'],
  ['opus', 'opus_48000_64', 'audio/ogg'],
] as const)(
  'preserves %s output and assembles audio chunks',
  async (responseFormat, outputFormat, mimeType) => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3]));
            controller.close();
          },
        })
      )
    );
    await expect(
      synthesizeSpeech({ ...params, opts: { responseFormat } })
    ).resolves.toEqual({
      audioContent: 'AQID',
      mimeType,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/test-voice?output_format=${outputFormat}`
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('xi-api-key')).toBe('test');
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('voice_settings');
  }
);

it.each([401, 422, 429, 500])(
  'preserves HTTP %s errors without retrying',
  async (status) => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'failure' }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(synthesizeSpeech(params)).rejects.toThrow(
      `ElevenLabs TTS returned ${status}`
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
);

it('rejects empty audio', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(new Uint8Array()));
  await expect(synthesizeSpeech(params)).rejects.toThrow(
    'ElevenLabs TTS returned empty audio'
  );
});

it('keeps the 30 second abort active while receiving audio', async () => {
  const controller = new AbortController();
  const timeout = jest
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  jest.spyOn(globalThis, 'fetch').mockImplementation(
    async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array([1]));
            init?.signal?.addEventListener('abort', () =>
              stream.error(new Error('aborted'))
            );
            queueMicrotask(() => controller.abort());
          },
        })
      )
  );
  await expect(synthesizeSpeech(params)).rejects.toThrow('aborted');
  expect(timeout).toHaveBeenCalledWith(30_000);
});

it('logs provider diagnostics without the key, input text or other response fields', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const apiKey = 'secret-api-key';
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        detail: {
          status: 'paid_plan_required',
          message: `Upgrade required: ${apiKey} ${params.text}`,
          input: params.text,
          api_key: apiKey,
        },
      }),
      {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'request-id': 'request-123',
        },
      }
    )
  );
  await expect(synthesizeSpeech({ ...params, apiKey })).rejects.toThrow(
    'ElevenLabs TTS returned 402'
  );
  expect(log).toHaveBeenCalledWith(
    'ElevenLabs TTS failed',
    expect.objectContaining({
      statusCode: 402,
      errorCode: 'paid_plan_required',
      requestId: 'request-123',
      languageCode: 'ja',
      model: 'eleven_v4',
      message: 'Upgrade required: [REDACTED] [REDACTED]',
    })
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain(apiKey);
  expect(JSON.stringify(log.mock.calls)).not.toContain(params.text);
});

it('sends the pinned English dictionary to ElevenLabs', async () => {
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(new Uint8Array([1])));
  await synthesizeSpeech({
    ...params,
    languageCode: 'en',
    text: 'Mine',
    dictionary: { pronunciationDictionaryId: 'stations', versionId: 'v1' },
  });
  expect(
    JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      .pronunciation_dictionary_locators
  ).toEqual([{ pronunciation_dictionary_id: 'stations', version_id: 'v1' }]);
});
