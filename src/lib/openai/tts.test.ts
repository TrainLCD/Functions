import {
  buildSpeechRequestBody,
  buildSpeechUrl,
  normalizeResponseFormat,
  parseSpeed,
} from './tts';

describe('buildSpeechUrl', () => {
  it('targets the OpenAI API directly when no gateway is configured', () => {
    expect(buildSpeechUrl()).toBe('https://api.openai.com/v1/audio/speech');
    expect(buildSpeechUrl('')).toBe('https://api.openai.com/v1/audio/speech');
  });

  it('routes through the AI Gateway when configured', () => {
    expect(buildSpeechUrl('https://gateway.example.com/v1/acct/gw')).toBe(
      'https://gateway.example.com/v1/acct/gw/openai/v1/audio/speech'
    );
  });

  it('tolerates trailing slashes on the gateway base url', () => {
    expect(buildSpeechUrl('https://gateway.example.com/v1/acct/gw///')).toBe(
      'https://gateway.example.com/v1/acct/gw/openai/v1/audio/speech'
    );
  });
});

describe('buildSpeechRequestBody', () => {
  it('sends the plain text as input with the model and voice', () => {
    expect(
      buildSpeechRequestBody({
        model: 'gpt-4o-mini-tts',
        voiceName: 'nova',
        text: '次は、オオサキです',
      })
    ).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: '次は、オオサキです',
      response_format: 'mp3',
    });
  });

  it('passes instructions through when provided', () => {
    // gpt-4o-mini-tts は SSML 非対応で、読み方は instructions で指示する
    const body = buildSpeechRequestBody({
      model: 'gpt-4o-mini-tts',
      voiceName: 'nova',
      text: 'The next station is Osaki.',
      opts: { instructions: 'calm female announcer' },
    });
    expect(body.instructions).toBe('calm female announcer');
  });

  it('omits optional fields that are not set', () => {
    const body = buildSpeechRequestBody({
      model: 'gpt-4o-mini-tts',
      voiceName: 'nova',
      text: 'test',
      opts: {},
    });
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('speed');
  });

  it('honors a custom response format and sends speed as a number', () => {
    // OpenAI の speed は number。文字列で送るとスキーマ検証に弾かれる
    const body = buildSpeechRequestBody({
      model: 'gpt-4o-mini-tts',
      voiceName: 'nova',
      text: 'test',
      opts: { responseFormat: 'wav', speed: 1.1 },
    });
    expect(body.response_format).toBe('wav');
    expect(body.speed).toBe(1.1);
    expect(typeof body.speed).toBe('number');
  });

  it('omits an out-of-range speed rather than sending an invalid value', () => {
    for (const speed of [0.1, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = buildSpeechRequestBody({
        model: 'gpt-4o-mini-tts',
        voiceName: 'nova',
        text: 'test',
        opts: { speed },
      });
      expect(body).not.toHaveProperty('speed');
    }
  });

  it('falls back to mp3 for an unknown or mis-cased response format', () => {
    // 環境変数由来の任意文字列をそのまま送ると OpenAI が 400 を返す
    expect(
      buildSpeechRequestBody({
        model: 'gpt-4o-mini-tts',
        voiceName: 'nova',
        text: 'test',
        opts: { responseFormat: 'MP3' },
      }).response_format
    ).toBe('mp3');
    expect(
      buildSpeechRequestBody({
        model: 'gpt-4o-mini-tts',
        voiceName: 'nova',
        text: 'test',
        opts: { responseFormat: 'wma' },
      }).response_format
    ).toBe('mp3');
  });

  it('drops instructions for models that do not support them', () => {
    // tts-1 / tts-1-hd に instructions を送ると OpenAI が 400 を返し、
    // /tts 全体が失敗する
    for (const model of ['tts-1', 'tts-1-hd']) {
      const body = buildSpeechRequestBody({
        model,
        voiceName: 'nova',
        text: 'test',
        opts: { instructions: 'calm female announcer' },
      });
      expect(body).not.toHaveProperty('instructions');
    }

    expect(
      buildSpeechRequestBody({
        model: 'gpt-4o-mini-tts',
        voiceName: 'nova',
        text: 'test',
        opts: { instructions: 'calm female announcer' },
      }).instructions
    ).toBe('calm female announcer');
  });
});

describe('normalizeResponseFormat', () => {
  it('accepts the known formats', () => {
    for (const format of ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']) {
      expect(normalizeResponseFormat(format)).toBe(format);
    }
  });

  it('normalizes case and falls back to mp3 for unknown values', () => {
    expect(normalizeResponseFormat('WAV')).toBe('wav');
    expect(normalizeResponseFormat('  Opus ')).toBe('opus');
    expect(normalizeResponseFormat('wma')).toBe('mp3');
    expect(normalizeResponseFormat('')).toBe('mp3');
    expect(normalizeResponseFormat(undefined)).toBe('mp3');
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
