import { ENGLISH_VOICE_ID } from './tts';

type VoicePair = { ja: string; en: string };

// SAIKYO uses the configured Japanese voice and Imogen, as do older clients.
const themeVoices = new Map<string, VoicePair>([
  // Konoha / Amelia
  ['TOKYO_METRO', { ja: 'T7yYq3WpB94yAuOXraRi', en: 'ZF6FPAbjXT4488VcRRnw' }],
  // Kuon / Brittney
  ['YAMANOTE', { ja: 'B8gJV1IhpuegLxdpXFOE', en: 'kPzsL2i3teMYv0FxEYQ6' }],
  // Hinata / Ellen
  ['JR_WEST', { ja: 'j210dv0vWm7fCknyQpbA', en: 'BIvP0GN1cAtSRTxNHnWS' }],
  // Harune / Hope
  ['TY', { ja: 'c2XJrw7TvNGtOc6r0ijG', en: 'tnSpp4vdxKPjI9w0GnoV' }],
  // Kenzo / Zara
  ['TOEI', { ja: 'b34JylakFZPlGS0BnwyY', en: 'jqcCZkN6Knx8BJ5TBdYR' }],
  // Otani / Sally Ford
  ['LED', { ja: '3JDquces8E8bkmvbh6Bc', en: 'kBag1HOZlaVBH7ICPE8x' }],
  // Eiko / Nichalia Schwartz
  ['JO', { ja: 'GR4dBIFsYe57TxyrHKXz', en: 'XfNU2rGpBa01ckF309OY' }],
  // Yui / Jessica Anne Bogart
  ['JL', { ja: 'fUjY9K2nAIwlALOwSiwc', en: 'lxYfHSkYm1EzQzGhdbfc' }],
  // Satomi / Arabella
  ['JR_KYUSHU', { ja: 'wcs09USXSN5Bl7FXohVZ', en: 'Z3R5wn05IrDiVCyEkUrK' }],
  // Sakura / Allison
  ['JR_315', { ja: 'EGPLqH9Wz2tNLu58EJVR', en: 'xctasy8XvGp2cVO9HL9k' }],
  // Saori / Lucy
  ['ODAKYU', { ja: 'ozfS3gQtjFX3kQyJ12dX', en: 'lcMyyd2HUfFzxdCaC4Ta' }],
  // Aki / Jessa
  ['E231', { ja: 'ngvNHfiCrXLPAHcTrZK1', en: 'yj30vwTGJxSHezdAGsv9' }],
  // Akari / Ivy
  ['E131', { ja: 'EkK6wL8GaH8IgBZTTDGJ', en: 'i4CzbCVWoqvD0P1QJCUL' }],
  // Ishibashi / Miranda
  ['SANYO', { ja: 'Mv8AjrYZCBkdsmDHNwcB', en: 'PoHUWWWMHFrA8z7Q88pu' }],
  // Shizuka / Lily Wolff
  ['LOW_POWER', { ja: 'WQz3clzUdMqvBf0jswZQ', en: 'qBDvhofpxp92JgXJxDjB' }],
]);

export const resolveThemeVoices = (
  theme: unknown,
  defaultJa: string
): VoicePair =>
  (typeof theme === 'string' && themeVoices.get(theme)) || {
    ja: defaultJa,
    en: ENGLISH_VOICE_ID,
  };
