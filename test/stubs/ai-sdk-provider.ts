/**
 * Jest 用の @ai-sdk/anthropic / @ai-sdk/openai / @ai-sdk/google-vertex スタブ
 * （ESM 専用のため差し替え）。モデル ID と生成時オプションをそのまま返すだけの形だけ互換。
 */
type ProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  project?: string;
  location?: string;
  googleCredentials?: {
    clientEmail?: string;
    privateKey?: string;
    privateKeyId?: string;
  };
};

const createProvider =
  (provider: string, options?: unknown) =>
  (
    modelId: string
  ): { modelId: string; provider: string; options?: unknown } => ({
    modelId,
    provider,
    options: options as ProviderOptions | undefined,
  });

export const createAnthropic = (options?: unknown) =>
  createProvider('anthropic', options);
export const createOpenAI = (options?: unknown) =>
  createProvider('openai', options);
export const createVertex = (options?: unknown) =>
  createProvider('google.vertex.chat', options);
