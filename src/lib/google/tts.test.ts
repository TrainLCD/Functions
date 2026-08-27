import {
  ALLOWED_CLIENT_SPEEDS,
  buildSynthesizeRequestBody,
  mimeTypeForFormat,
  normalizeResponseFormat,
  parseClientSpeed,
  parsePitch,
  parseSpeed,
} from './tts';

describe('parseClientSpeed', () => {
  it('accepts the announcement speed presets', () => {
    for (const speed of ALLOWED_CLIENT_SPEEDS) {
      expect(parseClientSpeed(speed)).toBe(speed);
    }
  });

  it('accepts a preset sent as a string', () => {
    expect(parseClientSpeed('1.15')).toBe(1.15);
  });

  it('ignores values outside the presets so the cache cannot be fanned out', () => {
    // 許可リスト方式。任意の値を通すと同じ文が速度違いで際限なくキャッシュされる
    for (const speed of [0.9, 1.05, 1.2, 2, 0.25, 4]) {
      expect(parseClientSpeed(speed)).toBeUndefined();
    }
  });

  it('treats missing and malformed values as unspecified', () => {
    for (const speed of [
      undefined,
      null,
      '',
      'fast',
      {},
      [],
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(parseClientSpeed(speed)).toBeUndefined();
    }
  });
});

describe('buildSynthesizeRequestBody', () => {
  it('sends the plain text with the voice and its locale', () => {
    expect(
      buildSynthesizeRequestBody({
        languageCode: 'ja-JP',
        voiceName: 'ja-JP-Standard-B',
        text: '次は、オオサキです',
      })
    ).toEqual({
      input: { text: '次は、オオサキです' },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Standard-B' },
      audioConfig: { audioEncoding: 'MP3' },
    });
  });

  it('omits speakingRate / pitch when they are not configured', () => {
    const body = buildSynthesizeRequestBody({
      languageCode: 'en-US',
      voiceName: 'en-US-Standard-G',
      text: 'test',
      opts: {},
    });
    expect(body.audioConfig).toEqual({ audioEncoding: 'MP3' });
  });

  it('sends speakingRate / pitch as numbers', () => {
    // 環境変数は文字列。そのまま送ると API のスキーマ検証に弾かれる
    const body = buildSynthesizeRequestBody({
      languageCode: 'ja-JP',
      voiceName: 'ja-JP-Standard-B',
      text: 'test',
      opts: { responseFormat: 'wav', speed: 1.15, pitch: -1.5 },
    });
    expect(body.audioConfig).toEqual({
      audioEncoding: 'LINEAR16',
      speakingRate: 1.15,
      pitch: -1.5,
    });
  });

  it('omits out-of-range values rather than sending an invalid request', () => {
    for (const speed of [0.1, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = buildSynthesizeRequestBody({
        languageCode: 'ja-JP',
        voiceName: 'ja-JP-Standard-B',
        text: 'test',
        opts: { speed },
      });
      expect(body.audioConfig).not.toHaveProperty('speakingRate');
    }
    for (const pitch of [-20.5, 20.5, Number.NaN]) {
      const body = buildSynthesizeRequestBody({
        languageCode: 'ja-JP',
        voiceName: 'ja-JP-Standard-B',
        text: 'test',
        opts: { pitch },
      });
      expect(body.audioConfig).not.toHaveProperty('pitch');
    }
  });
});

describe('normalizeResponseFormat', () => {
  it('accepts the formats Cloud TTS can return', () => {
    for (const format of ['mp3', 'wav', 'opus']) {
      expect(normalizeResponseFormat(format)).toBe(format);
    }
  });

  it('normalizes case and falls back to mp3 for unknown values', () => {
    expect(normalizeResponseFormat('WAV')).toBe('wav');
    expect(normalizeResponseFormat('  Opus ')).toBe('opus');
    // OpenAI 時代の設定値が残っていても 400 にせず mp3 で合成する
    expect(normalizeResponseFormat('aac')).toBe('mp3');
    expect(normalizeResponseFormat('flac')).toBe('mp3');
    expect(normalizeResponseFormat('pcm')).toBe('mp3');
    expect(normalizeResponseFormat('')).toBe('mp3');
    expect(normalizeResponseFormat(undefined)).toBe('mp3');
  });
});

describe('mimeTypeForFormat', () => {
  it('maps each format to the container Cloud TTS actually returns', () => {
    // LINEAR16 は RIFF ヘッダ付き、OGG_OPUS は Ogg コンテナで返る
    expect(mimeTypeForFormat('mp3')).toBe('audio/mpeg');
    expect(mimeTypeForFormat('wav')).toBe('audio/wav');
    expect(mimeTypeForFormat('opus')).toBe('audio/ogg');
    expect(mimeTypeForFormat('unknown')).toBe('audio/mpeg');
  });
});

describe('parseSpeed', () => {
  it('parses a numeric string from the environment', () => {
    expect(parseSpeed('1.1')).toBe(1.1);
    expect(parseSpeed(' 0.25 ')).toBe(0.25);
    expect(parseSpeed('4')).toBe(4);
  });

  it('accepts numbers as-is', () => {
    expect(parseSpeed(1.5)).toBe(1.5);
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(parseSpeed('0.24')).toBeUndefined();
    expect(parseSpeed('4.01')).toBeUndefined();
    expect(parseSpeed('fast')).toBeUndefined();
    expect(parseSpeed('')).toBeUndefined();
    expect(parseSpeed(undefined)).toBeUndefined();
  });
});

describe('parsePitch', () => {
  it('accepts the semitone range, including negatives', () => {
    expect(parsePitch('-20')).toBe(-20);
    expect(parsePitch('0')).toBe(0);
    expect(parsePitch('20')).toBe(20);
    expect(parsePitch(2.5)).toBe(2.5);
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(parsePitch('-20.1')).toBeUndefined();
    expect(parsePitch('20.1')).toBeUndefined();
    expect(parsePitch('high')).toBeUndefined();
    expect(parsePitch(undefined)).toBeUndefined();
  });
});
