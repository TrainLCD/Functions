import {
  isOpenAiVoiceName,
  isTtsModel,
  resolveOpenAiVoiceName,
  resolveTtsModel,
} from './ttsVoice';

describe('ttsVoice (OpenAI)', () => {
  it('accepts OpenAI voice presets', () => {
    expect(isOpenAiVoiceName('nova')).toBe(true);
    expect(isOpenAiVoiceName('shimmer')).toBe(true);
    expect(isOpenAiVoiceName('coral')).toBe(true);
    expect(isOpenAiVoiceName('alloy')).toBe(true);
  });

  it('accepts voice names case-insensitively and with surrounding spaces', () => {
    expect(isOpenAiVoiceName('Nova')).toBe(true);
    expect(isOpenAiVoiceName('  NOVA  ')).toBe(true);
  });

  it('rejects unknown voice ids', () => {
    // Azure/Google 時代のボイス名がそのまま送られてきても弾く
    expect(isOpenAiVoiceName('ja-JP-NanamiNeural')).toBe(false);
    expect(isOpenAiVoiceName('ja-JP-Standard-B')).toBe(false);
    expect(isOpenAiVoiceName('')).toBe(false);
  });

  it('prefers a valid requested voice', () => {
    expect(resolveOpenAiVoiceName('shimmer', 'coral', 'nova')).toBe('shimmer');
  });

  it('normalizes the resolved voice to lower case', () => {
    expect(resolveOpenAiVoiceName('Shimmer', 'coral', 'nova')).toBe('shimmer');
  });

  it('falls back to a configured voice when the request is invalid', () => {
    expect(resolveOpenAiVoiceName('ja-JP-NanamiNeural', 'coral', 'nova')).toBe(
      'coral'
    );
  });

  it('falls back to the default voice when both inputs are invalid', () => {
    expect(
      resolveOpenAiVoiceName('ja-JP-NanamiNeural', 'en-US-JennyNeural', 'nova')
    ).toBe('nova');
  });

  it('falls back to the default voice for non-string inputs', () => {
    expect(resolveOpenAiVoiceName(undefined, undefined, 'nova')).toBe('nova');
    expect(resolveOpenAiVoiceName(42, {}, 'nova')).toBe('nova');
  });
});

describe('resolveTtsModel', () => {
  it('accepts the allowed TTS models', () => {
    expect(isTtsModel('gpt-4o-mini-tts')).toBe(true);
    expect(isTtsModel('tts-1')).toBe(true);
    expect(isTtsModel('tts-1-hd')).toBe(true);
  });

  it('rejects models outside the allowlist', () => {
    // クライアントに高額なモデルを名指しさせない
    expect(isTtsModel('gpt-4o')).toBe(false);
    expect(isTtsModel('gpt-5.6-luna')).toBe(false);
    expect(isTtsModel('')).toBe(false);
  });

  it('prefers a valid requested model', () => {
    expect(resolveTtsModel('tts-1-hd', 'tts-1', 'gpt-4o-mini-tts')).toBe(
      'tts-1-hd'
    );
  });

  it('falls back through config to the default for disallowed models', () => {
    expect(resolveTtsModel('gpt-4o', 'tts-1', 'gpt-4o-mini-tts')).toBe('tts-1');
    expect(resolveTtsModel('gpt-4o', 'gpt-4o', 'gpt-4o-mini-tts')).toBe(
      'gpt-4o-mini-tts'
    );
    expect(resolveTtsModel(undefined, undefined, 'gpt-4o-mini-tts')).toBe(
      'gpt-4o-mini-tts'
    );
  });
});
