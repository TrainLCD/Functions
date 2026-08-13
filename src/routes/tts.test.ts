import { CallableError } from '../lib/callable';
import { parseTtsText, resolveInstructions } from './tts';

describe('parseTtsText', () => {
  it('returns the trimmed text', () => {
    expect(parseTtsText('  次は、オオサキです  ', 'textJa')).toBe(
      '次は、オオサキです'
    );
  });

  it('treats undefined/null/empty as "language not requested"', () => {
    // 合成は文字数課金のため、アプリは無効な言語を送ってこない
    expect(parseTtsText(undefined, 'textJa')).toBe('');
    expect(parseTtsText(null, 'textJa')).toBe('');
    expect(parseTtsText('   ', 'textJa')).toBe('');
  });

  it('rejects non-string values', () => {
    expect(() => parseTtsText(42, 'textJa')).toThrow(CallableError);
    expect(() => parseTtsText({}, 'textEn')).toThrow(/must be a string/);
  });

  it('strips tags so stray SSML is never read aloud', () => {
    // gpt-4o-mini-tts は SSML を解釈せずタグをそのまま読み上げてしまう
    expect(
      parseTtsText('次は<sub alias="オオサキ">大崎</sub>です', 'textJa')
    ).toBe('次はオオサキです');
  });

  it('leaves plain text untouched', () => {
    expect(parseTtsText('The next station is Osaki, J-Y 24.', 'textEn')).toBe(
      'The next station is Osaki, J-Y 24.'
    );
  });

  it('rejects text beyond the byte limit', () => {
    // 日本語は 1 文字 3 バイトなので 4000 バイト超はすぐ作れる
    const long = 'あ'.repeat(1400);
    expect(() => parseTtsText(long, 'textJa')).toThrow(/byte limit/);
  });

  it('measures the limit in bytes, not characters', () => {
    // 1300 文字 = 3900 バイトなので通る
    expect(parseTtsText('あ'.repeat(1300), 'textJa')).toHaveLength(1300);
  });
});

describe('resolveInstructions', () => {
  it('prefers the requested instructions', () => {
    expect(resolveInstructions('requested', 'configured', 'fallback')).toBe(
      'requested'
    );
  });

  it('falls back to KV config, then to the env default', () => {
    expect(resolveInstructions(undefined, 'configured', 'fallback')).toBe(
      'configured'
    );
    expect(resolveInstructions(undefined, undefined, 'fallback')).toBe(
      'fallback'
    );
    expect(resolveInstructions('   ', '  ', 'fallback')).toBe('fallback');
  });

  it('returns an empty string when nothing is configured', () => {
    expect(resolveInstructions(undefined, undefined, undefined)).toBe('');
  });

  it('ignores non-string requests', () => {
    expect(resolveInstructions(42, undefined, 'fallback')).toBe('fallback');
  });

  it('truncates rather than failing when the instructions are too long', () => {
    // 読み方の指示は本文ではないため、長すぎても放送そのものは落とさない
    const result = resolveInstructions('x'.repeat(5000), undefined, undefined);
    expect(result).toHaveLength(2000);
  });
});
