/**
 * OpenAI TTS のボイス名を扱うユーティリティ。
 *
 * gpt-4o-mini-tts のボイスは固定の名前付きプリセット（`nova` など）で、Azure の
 * ような `<locale>-<Name>Neural` 形式ではない。ボイスは多言語対応のため日英で
 * 同じ名前を使える。クライアントから任意文字列が渡るため、未知の名前は
 * そのまま OpenAI へ流さず既定値へ倒す（400 で放送を落とさないため）。
 */

// OpenAI Audio Speech API が受け付けるボイス。女性寄りは nova / shimmer / coral / sage。
const OPENAI_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
]);

export const isOpenAiVoiceName = (voiceName: string): boolean =>
  OPENAI_VOICES.has(voiceName.trim().toLowerCase());

/**
 * 使用するボイス名を決める。
 * 優先順位: リクエスト指定 → KV の設定 → 環境変数の既定値。
 * 前二者は妥当なボイス名のときだけ採用する。
 */
export const resolveOpenAiVoiceName = (
  requestedVoiceName: unknown,
  configuredVoiceName: unknown,
  defaultVoiceName: string
): string => {
  const requested =
    typeof requestedVoiceName === 'string' ? requestedVoiceName.trim() : '';
  if (requested && isOpenAiVoiceName(requested)) {
    return requested.toLowerCase();
  }

  const configured =
    typeof configuredVoiceName === 'string' ? configuredVoiceName.trim() : '';
  if (configured && isOpenAiVoiceName(configured)) {
    return configured.toLowerCase();
  }

  return defaultVoiceName;
};

// 合成に使ってよいモデル。クライアントの指定をそのまま OpenAI へ流すと、
// 高額なモデルを名指しされて課金が膨らむため許可制にする。
const TTS_MODELS = new Set(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);

export const isTtsModel = (model: string): boolean =>
  TTS_MODELS.has(model.trim().toLowerCase());

/**
 * 使用するモデルを決める。ボイス名と同じく、リクエスト → KV 設定 → 環境変数の
 * 順で、許可済みのモデル名のときだけ採用する。
 */
export const resolveTtsModel = (
  requestedModel: unknown,
  configuredModel: unknown,
  defaultModel: string
): string => {
  const requested =
    typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (requested && isTtsModel(requested)) {
    return requested.toLowerCase();
  }

  const configured =
    typeof configuredModel === 'string' ? configuredModel.trim() : '';
  if (configured && isTtsModel(configured)) {
    return configured.toLowerCase();
  }

  return defaultModel;
};
