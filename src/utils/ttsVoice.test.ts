import {
  DEFAULT_TTS_VOICE,
  isGoogleVoiceName,
  languageCodeFromVoiceName,
  resolveGoogleVoiceName,
} from './ttsVoice';

describe('isGoogleVoiceName', () => {
  it('accepts the voice families we allow', () => {
    expect(isGoogleVoiceName('ja-JP-Standard-B', 'ja')).toBe(true);
    expect(isGoogleVoiceName('ja-JP-Wavenet-A', 'ja')).toBe(true);
    expect(isGoogleVoiceName('ja-JP-Neural2-B', 'ja')).toBe(true);
    expect(isGoogleVoiceName('en-US-Standard-G', 'en')).toBe(true);
    expect(isGoogleVoiceName('  en-GB-Standard-A  ', 'en')).toBe(true);
  });

  it('rejects families that are far more expensive per character', () => {
    // クライアントに高単価のボイスを名指しさせない
    expect(isGoogleVoiceName('ja-JP-Chirp3-HD-Aoede', 'ja')).toBe(false);
    expect(isGoogleVoiceName('en-US-Studio-O', 'en')).toBe(false);
    expect(isGoogleVoiceName('Kore', 'en')).toBe(false);
  });

  it('rejects a voice whose language does not match the text', () => {
    // ja のテキストに en のボイスを渡すと Cloud TTS が 400 を返す
    expect(isGoogleVoiceName('en-US-Standard-G', 'ja')).toBe(false);
    expect(isGoogleVoiceName('ja-JP-Standard-B', 'en')).toBe(false);
  });

  it('rejects names from the previous engines', () => {
    expect(isGoogleVoiceName('shimmer', 'ja')).toBe(false);
    expect(isGoogleVoiceName('ja-JP-NanamiNeural', 'ja')).toBe(false);
    expect(isGoogleVoiceName('', 'ja')).toBe(false);
  });
});

describe('languageCodeFromVoiceName', () => {
  it('derives the locale from the voice name', () => {
    // voice.name と languageCode の食い違いは 400 になるため名前から導出する
    expect(languageCodeFromVoiceName('ja-JP-Standard-B')).toBe('ja-JP');
    expect(languageCodeFromVoiceName('en-GB-Wavenet-A')).toBe('en-GB');
  });
});

describe('resolveGoogleVoiceName', () => {
  it('prefers a valid requested voice', () => {
    expect(
      resolveGoogleVoiceName(
        'ja-JP-Wavenet-A',
        'ja-JP-Standard-A',
        'ja-JP-Standard-B',
        'ja'
      )
    ).toBe('ja-JP-Wavenet-A');
  });

  it('falls back to the KV config, then to the env default', () => {
    expect(
      resolveGoogleVoiceName(
        'ja-JP-Chirp3-HD-Aoede',
        'ja-JP-Standard-A',
        'ja-JP-Standard-B',
        'ja'
      )
    ).toBe('ja-JP-Standard-A');
    expect(
      resolveGoogleVoiceName(undefined, undefined, 'ja-JP-Standard-B', 'ja')
    ).toBe('ja-JP-Standard-B');
    expect(resolveGoogleVoiceName(42, {}, 'en-US-Standard-G', 'en')).toBe(
      'en-US-Standard-G'
    );
  });

  it('validates the env default too, so a stale OpenAI value never reaches Google', () => {
    // 環境変数の設定ミスをそのまま送ると Google が 400 を返し /tts が落ちる
    expect(resolveGoogleVoiceName(undefined, undefined, 'shimmer', 'ja')).toBe(
      DEFAULT_TTS_VOICE.ja
    );
    expect(resolveGoogleVoiceName(undefined, undefined, undefined, 'en')).toBe(
      DEFAULT_TTS_VOICE.en
    );
  });

  it('never returns a voice from the wrong language', () => {
    expect(
      resolveGoogleVoiceName(
        'ja-JP-Standard-B',
        'ja-JP-Wavenet-A',
        'ja-JP-Neural2-B',
        'en'
      )
    ).toBe(DEFAULT_TTS_VOICE.en);
  });
});
