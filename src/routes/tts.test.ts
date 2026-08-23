import { CallableError } from '../lib/callable';
import { computeId, parseTtsText } from './tts';

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
    // Cloud TTS の input.text は SSML を解釈せずタグをそのまま読み上げてしまう
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

describe('computeId', () => {
  const base = {
    enVoiceName: 'en-US-Standard-G',
    jaVoiceName: 'ja-JP-Standard-B',
    pitch: null as number | null,
    responseFormat: 'mp3',
    speed: null as number | null,
    textEn: 'The next station is Osaki.',
    textJa: '次は、オオサキです',
  };

  it('is stable for identical input', async () => {
    expect(await computeId(base)).toBe(await computeId(base));
  });

  it.each([
    ['textJa', { textJa: '次は、シンジュクです' }],
    ['textEn', { textEn: 'The next station is Shinjuku.' }],
    ['jaVoiceName', { jaVoiceName: 'ja-JP-Wavenet-A' }],
    ['enVoiceName', { enVoiceName: 'en-US-Wavenet-F' }],
    // responseFormat / speed はかつてネストしたオブジェクトに置いていたため、
    // JSON.stringify の配列 replacer に落とされて ID に反映されていなかった
    ['responseFormat', { responseFormat: 'wav' }],
    ['speed', { speed: 1.25 }],
    ['pitch', { pitch: 1.5 }],
  ])('changes when %s changes', async (_name, override) => {
    expect(await computeId({ ...base, ...override })).not.toBe(
      await computeId(base)
    );
  });

  it('distinguishes single-language requests from bilingual ones', async () => {
    // 片言語リクエストが両言語のキャッシュへヒットしないこと
    const jaOnly = await computeId({ ...base, textEn: '' });
    const enOnly = await computeId({ ...base, textJa: '' });
    const both = await computeId(base);
    expect(new Set([jaOnly, enOnly, both]).size).toBe(3);
  });
});
