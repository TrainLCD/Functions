import { resolveThemeVoices } from './themeVoices';

const themes = [
  'TOKYO_METRO',
  'YAMANOTE',
  'JR_WEST',
  'TY',
  'SAIKYO',
  'TOEI',
  'LED',
  'JO',
  'JL',
  'JR_KYUSHU',
  'JR_315',
  'ODAKYU',
  'E231',
  'E131',
  'SANYO',
  'LOW_POWER',
];

it('assigns a distinct voice to each theme even when only one language is enabled', () => {
  const voices = themes.map((theme) =>
    resolveThemeVoices(theme, 't3iNwCjYhE9IEQPVBlys')
  );
  for (const language of ['ja', 'en'] as const) {
    expect(new Set(voices.map((pair) => pair[language])).size).toBe(
      themes.length
    );
  }
});

it.each([undefined, null, 'SAIKYO', 'FUTURE_THEME', 'constructor', 42])(
  'uses the existing voices for %p',
  (theme) => {
    expect(resolveThemeVoices(theme, 'configured')).toEqual({
      ja: 'configured',
      en: 'jv41DhCf464zw0TI7I1w',
    });
  }
);
