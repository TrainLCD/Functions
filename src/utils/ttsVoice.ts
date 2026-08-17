/**
 * Google Cloud TTS のボイス名を扱うユーティリティ。
 *
 * ボイス名は `<言語>-<地域>-<系統>-<記号>`（例: ja-JP-Standard-B）で、Azure と同じく
 * ロケールを含む。言語ごとに別のボイスを指定する必要があるため、日英で共通の名前は
 * 使えない（OpenAI の `shimmer` のような多言語プリセットとは異なる）。
 *
 * クライアントから任意文字列が渡るため、未知の名前はそのまま Google へ流さず
 * 既定値へ倒す（400 で放送を落とさないため）。
 */

export type TtsLanguage = 'ja' | 'en';

/**
 * クライアント指定を許すボイス系統。Android の端末内蔵 TTS と同水準の音質を狙う
 * 系統に限定する。Studio / Chirp3-HD / Gemini-TTS は単価が桁違いで、名指しされると
 * 課金が膨らむため受け付けない（系統を変えるときは環境変数の既定値ごと入れ替える）。
 */
const ALLOWED_VOICE_FAMILIES = ['Standard', 'Wavenet', 'Neural2'] as const;

const VOICE_NAME_PATTERN = new RegExp(
  `^([a-z]{2})-([A-Z]{2})-(?:${ALLOWED_VOICE_FAMILIES.join('|')})-[A-Z]$`
);

// 環境変数の設定ミス（OpenAI 時代の "shimmer" の残留など）でも合成を落とさない
// ための最終フォールバック。ここは実在を確認済みの女性ボイス。
export const DEFAULT_TTS_VOICE: Record<TtsLanguage, string> = {
  ja: 'ja-JP-Standard-B',
  en: 'en-US-Standard-G',
};

/** ボイス名がその言語向けの許可済みボイスか。 */
export const isGoogleVoiceName = (
  voiceName: string,
  language: TtsLanguage
): boolean => {
  const matched = VOICE_NAME_PATTERN.exec(voiceName.trim());
  return matched?.[1] === language;
};

/**
 * ボイス名からロケール（languageCode）を取り出す。Cloud TTS は voice.name と
 * voice.languageCode の食い違いを 400 で弾くため、必ず名前から導出する。
 */
export const languageCodeFromVoiceName = (voiceName: string): string =>
  voiceName.trim().split('-').slice(0, 2).join('-');

/**
 * 使用するボイス名を決める。
 * 優先順位: リクエスト指定 → KV の設定 → 環境変数の既定値。
 * いずれも「その言語向けの許可済みボイス」のときだけ採用する。
 */
export const resolveGoogleVoiceName = (
  requestedVoiceName: unknown,
  configuredVoiceName: unknown,
  defaultVoiceName: string | undefined,
  language: TtsLanguage
): string => {
  const candidates = [
    requestedVoiceName,
    configuredVoiceName,
    defaultVoiceName,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    // 環境変数由来の既定値も無検証では通さない。不正なら Google が 400 を返し、
    // /tts 全体が失敗してしまうため、既知のボイスへ倒す。
    if (value && isGoogleVoiceName(value, language)) {
      return value;
    }
  }
  return DEFAULT_TTS_VOICE[language];
};
