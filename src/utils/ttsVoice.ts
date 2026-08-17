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
 * 使用を許すボイス名（`voices.list` で実在を確認済み）。
 *
 * 形式（`<言語>-<地域>-<系統>-<記号>`）だけを検証すると `ja-US-Standard-A` や
 * `ja-JP-Standard-Z` のような実在しない名前を通してしまい、Cloud TTS が
 * 400（"Voice ... does not exist"）を返して放送そのものが落ちる。既定値へ倒す
 * ためには実在する名前だけを許可する必要がある。
 *
 * 系統は Standard / Wavenet / Neural2 に限定する。Android の端末内蔵 TTS と
 * 同水準の音質を狙う系統で、Studio / Chirp3-HD / Gemini-TTS は単価が桁違いなので
 * 名指しされても受け付けない。
 *
 * ロケールは実際に使う ja-JP / en-US のみ。他ロケール（en-GB など）や Google が
 * 後から追加したボイスを使うときは、`voices.list` で実在を確認してここへ足す。
 */
const ALLOWED_VOICES: Record<TtsLanguage, ReadonlySet<string>> = {
  ja: new Set([
    'ja-JP-Standard-A',
    'ja-JP-Standard-B',
    'ja-JP-Standard-C',
    'ja-JP-Standard-D',
    'ja-JP-Wavenet-A',
    'ja-JP-Wavenet-B',
    'ja-JP-Wavenet-C',
    'ja-JP-Wavenet-D',
    // Neural2 の ja-JP は A が無い
    'ja-JP-Neural2-B',
    'ja-JP-Neural2-C',
    'ja-JP-Neural2-D',
  ]),
  en: new Set([
    'en-US-Standard-A',
    'en-US-Standard-B',
    'en-US-Standard-C',
    'en-US-Standard-D',
    'en-US-Standard-E',
    'en-US-Standard-F',
    'en-US-Standard-G',
    'en-US-Standard-H',
    'en-US-Standard-I',
    'en-US-Standard-J',
    'en-US-Wavenet-A',
    'en-US-Wavenet-B',
    'en-US-Wavenet-C',
    'en-US-Wavenet-D',
    'en-US-Wavenet-E',
    'en-US-Wavenet-F',
    'en-US-Wavenet-G',
    'en-US-Wavenet-H',
    'en-US-Wavenet-I',
    'en-US-Wavenet-J',
    // Neural2 の en-US は B が無い
    'en-US-Neural2-A',
    'en-US-Neural2-C',
    'en-US-Neural2-D',
    'en-US-Neural2-E',
    'en-US-Neural2-F',
    'en-US-Neural2-G',
    'en-US-Neural2-H',
    'en-US-Neural2-I',
    'en-US-Neural2-J',
  ]),
};

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
): boolean => ALLOWED_VOICES[language].has(voiceName.trim());

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
