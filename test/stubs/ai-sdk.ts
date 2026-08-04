/**
 * Jest 用の `ai`（Vercel AI SDK）スタブ。
 * ai v7 は ESM 専用で Jest の CJS ランタイムから require できないため、
 * テストでは形だけ互換のスタブへ差し替える（jest.config.js の moduleNameMapper）。
 * streamText を使うテストは各テスト側でモックを注入する。
 * ランタイム結合はリポジトリ方針どおり wrangler dev で確認する。
 */
export const tool = <T>(definition: T): T => definition;

export const stepCountIs = (
  count: number
): { type: 'step-count'; count: number } => ({
  type: 'step-count',
  count,
});

export const Output = {
  object: <T>(options: T): T => options,
};

export const generateText = async (): Promise<never> => {
  throw new Error(
    'ai.generateText is not available in Jest; inject a mock instead'
  );
};

export const streamText = (): never => {
  throw new Error(
    'ai.streamText is not available in Jest; inject a mock instead'
  );
};

export type LanguageModel = unknown;
