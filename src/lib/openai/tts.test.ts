import { buildSpeechRequestBody, buildSpeechUrl } from './tts';

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

  it('honors a custom response format and speed', () => {
    const body = buildSpeechRequestBody({
      model: 'gpt-4o-mini-tts',
      voiceName: 'nova',
      text: 'test',
      opts: { responseFormat: 'wav', speed: '1.1' },
    });
    expect(body.response_format).toBe('wav');
    expect(body.speed).toBe('1.1');
  });
});
