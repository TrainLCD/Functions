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

it.each([undefined, null, ...themes, 'FUTURE_THEME', 'constructor', 42])(
  'uses the existing voices for %p',
  (theme) => {
    expect(resolveThemeVoices(theme, 'configured')).toEqual({
      ja: 'configured',
      en: 'jv41DhCf464zw0TI7I1w',
    });
  }
);
