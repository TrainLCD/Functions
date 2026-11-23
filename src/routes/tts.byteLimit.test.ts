import type { Env } from '../types';

jest.mock('../lib/auth/session', () => ({ verifySessionToken: jest.fn() }));
jest.mock('../lib/ttsCache', () => ({
  writeTtsCache: jest.fn().mockResolvedValue(undefined),
}));
const audio = { audioContent: 'AQ==', mimeType: 'audio/mpeg' };
jest.mock('../lib/google/tts', () => ({
  synthesizeSpeech: jest.fn().mockResolvedValue(audio),
}));
jest.mock('../lib/elevenlabs/tts', () => ({
  ...jest.requireActual('../lib/elevenlabs/tts'),
  synthesizeSpeech: jest.fn().mockResolvedValue(audio),
}));

// 各ケースで config:tts のインメモリキャッシュを初期化する。
beforeEach(() => {
  jest.resetModules();
});

const request = async (
  provider: 'google' | 'elevenlabs',
  textEn: string,
  textJa?: string
) => {
  const { handleTts } = await import('./tts');
  const env = {
    GOOGLE_TTS_SA_KEY: 'test',
    ELEVENLABS_API_KEY: 'test',
    TTS_KV: {
      get: async (key: string) => (key === 'config:tts' ? { provider } : null),
    },
  } as unknown as Env;
  return handleTts(
    new Request('https://example.com/tts', {
      method: 'POST',
      body: JSON.stringify({ data: { textEn, textJa } }),
    }),
    env,
    { waitUntil: jest.fn() } as unknown as ExecutionContext
  );
};

// 714 個の "Me-nay " で 4998 バイト。末尾の é は UTF-8 で 2 バイト。
const boundaryText = `${'Mine '.repeat(714)}é`;

it('synthesizes exactly 5000 bytes of Google English text', async () => {
  const response = await request('google', boundaryText);
  expect(await response.json()).toMatchObject({
    result: { enAudioContent: audio.audioContent },
  });
  const { synthesizeSpeech } = await import('../lib/google/tts');
  expect(synthesizeSpeech).toHaveBeenCalledWith(
    expect.objectContaining({ text: `${'Me-nay '.repeat(714)}é` })
  );
});

it('rejects 5001 bytes before synthesizing either language', async () => {
  await expect(
    request('google', `${boundaryText}!`, '次は')
  ).rejects.toMatchObject({
    code: 'invalid-argument',
    message: expect.stringContaining('5001 bytes'),
  });
  const { synthesizeSpeech } = await import('../lib/google/tts');
  expect(synthesizeSpeech).not.toHaveBeenCalled();
});

it('sends normalized English over 5000 bytes to ElevenLabs', async () => {
  const response = await request('elevenlabs', '&'.repeat(1700));
  expect(await response.json()).toMatchObject({
    result: { enAudioContent: audio.audioContent },
  });
  const { synthesizeSpeech } = await import('../lib/elevenlabs/tts');
  expect(synthesizeSpeech).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'and'.repeat(1700) })
  );
});
