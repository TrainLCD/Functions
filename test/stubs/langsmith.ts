/**
 * Jest 用の langsmith スタブ（ESM 依存チェーンを避けるための差し替え）。
 */
export class Client {
  async awaitPendingTraceBatches(): Promise<void> {}
}

/** langsmith/experimental/vercel の wrapAISDK 互換（何もラップしない） */
export const wrapAISDK = <T>(ai: T, _config?: unknown): T => ai;
