/**
 * Jest 用の @ai-sdk/anthropic / @ai-sdk/openai スタブ（ESM 専用のため差し替え）。
 * モデル ID をそのまま返すだけの形だけ互換。
 */
const createProvider =
  () =>
  (modelId: string): { modelId: string } => ({ modelId });

export const createAnthropic = (_options?: unknown) => createProvider();
export const createOpenAI = (_options?: unknown) => createProvider();
