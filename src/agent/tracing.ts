/**
 * LangSmith によるエージェント妥当性検証用のトレーシング。
 * 会話本文が LangSmith へ送信されるため dev 環境のみで有効化する
 * （LANGSMITH_TRACING=true かつ LANGSMITH_API_KEY 設定時。本番では無効のまま）。
 * AI SDK の streamText を wrapAISDK でラップし、ツール呼び出し・
 * トークン使用量・レイテンシをターン単位で記録する。
 */
import * as ai from 'ai';
import { Client } from 'langsmith';
import { wrapAISDK } from 'langsmith/experimental/vercel';
import type { Env } from '../types';

export type StreamTextFn = typeof ai.streamText;

export interface AgentLLMRuntime {
  streamText: StreamTextFn;
  /** 溜まったトレースの送信完了を待つ。Worker では ctx.waitUntil に渡すこと */
  flush: () => Promise<void>;
}

export const resolveAgentLLMRuntime = (env: Env): AgentLLMRuntime => {
  if (env.LANGSMITH_TRACING !== 'true' || !env.LANGSMITH_API_KEY) {
    return { streamText: ai.streamText, flush: async () => {} };
  }
  const client = new Client({ apiKey: env.LANGSMITH_API_KEY });
  const { streamText } = wrapAISDK(ai, { client, name: 'agent-chat' });
  return {
    // ラップ版は結果を Promise で返すが、呼び出し側が await するため差異は吸収される
    streamText: streamText as unknown as StreamTextFn,
    flush: async () => {
      try {
        await client.awaitPendingTraceBatches();
      } catch (e) {
        console.warn('agent tracing: failed to flush LangSmith traces', e);
      }
    },
  };
};
