import type { Env } from '../types';
import { writeTtsCache } from './ttsCache';

const createEnv = () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const kvPut = jest.fn().mockResolvedValue(undefined);
  return {
    env: {
      TTS_BUCKET: { put },
      TTS_KV: { put: kvPut },
    } as unknown as Env,
    put,
    kvPut,
  };
};

const basePayload = {
  id: 'abc123',
  model: 'gpt-4o-mini-tts',
  jaAudioContent: 'QQ==',
  enAudioContent: 'QQ==',
  jaAudioMimeType: 'audio/mpeg',
  enAudioMimeType: 'audio/mpeg',
  textJa: '次は、オオサキです',
  textEn: 'The next station is Osaki.',
  voiceJa: 'nova',
  voiceEn: 'nova',
};

describe('writeTtsCache', () => {
  it('stores both languages and records the metadata', async () => {
    const { env, put, kvPut } = createEnv();

    await writeTtsCache(basePayload, env);

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][0]).toBe('caches/tts/ja/abc123.mp3');
    expect(put.mock.calls[1][0]).toBe('caches/tts/en/abc123.mp3');

    const meta = JSON.parse(kvPut.mock.calls[0][1]);
    expect(kvPut.mock.calls[0][0]).toBe('voice:abc123');
    expect(meta).toEqual(
      expect.objectContaining({
        id: 'abc123',
        model: 'gpt-4o-mini-tts',
        pathJa: 'caches/tts/ja/abc123.mp3',
        pathEn: 'caches/tts/en/abc123.mp3',
        textJa: '次は、オオサキです',
        textEn: 'The next station is Osaki.',
      })
    );
  });

  it('stores only the language that was synthesized', async () => {
    // ユーザーが英語を無効にしている場合、英語は合成もキャッシュもしない
    const { env, put, kvPut } = createEnv();

    await writeTtsCache(
      {
        ...basePayload,
        enAudioContent: undefined,
        enAudioMimeType: undefined,
        textEn: '',
        voiceEn: undefined,
      },
      env
    );

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe('caches/tts/ja/abc123.mp3');

    const meta = JSON.parse(kvPut.mock.calls[0][1]);
    expect(meta.pathJa).toBe('caches/tts/ja/abc123.mp3');
    expect(meta).not.toHaveProperty('pathEn');
    expect(meta).not.toHaveProperty('textEn');
  });

  it('picks the file extension from the mime type', async () => {
    const { env, put } = createEnv();

    await writeTtsCache(
      {
        ...basePayload,
        jaAudioMimeType: 'audio/wav',
        enAudioMimeType: 'audio/pcm;rate=24000',
      },
      env
    );

    expect(put.mock.calls[0][0]).toBe('caches/tts/ja/abc123.wav');
    expect(put.mock.calls[1][0]).toBe('caches/tts/en/abc123.pcm');
  });

  it('writes nothing when no audio was produced', async () => {
    const { env, put, kvPut } = createEnv();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    await writeTtsCache(
      {
        id: 'abc123',
        model: 'gpt-4o-mini-tts',
      },
      env
    );

    expect(put).not.toHaveBeenCalled();
    expect(kvPut).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
