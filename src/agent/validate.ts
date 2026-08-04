/**
 * /agent/chat の入力検証と、提案駅のサーバ側検証（純関数）。
 * モデル出力を信用せず、このターンのツール結果（実在確認済み駅）と
 * 突合することで「LLM が駅をでっち上げる」経路を構造的に塞ぐ。
 */
import { CallableError } from '../lib/callable';
import {
  AGENT_MAX_SUGGESTIONS,
  type ChatRequest,
  chatRequestSchema,
  type StationSuggestion,
} from './schema';

/** callable の data を検証して ChatRequest を返す。不正なら invalid-argument。 */
export const parseChatRequest = (data: unknown): ChatRequest => {
  const parsed = chatRequestSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'request';
    throw new CallableError(
      'invalid-argument',
      `${path}: ${issue?.message ?? 'invalid'}`
    );
  }
  return parsed.data;
};

/**
 * LLM が返した suggestions をツール結果と突合する。
 * - このターンで実在確認できた駅（verified）に含まれない stationId は破棄
 * - 名称等は LLM 出力ではなく検証済みデータで上書き（内容の改変を防ぐ）
 * - stationId の重複を除去し、先頭 AGENT_MAX_SUGGESTIONS 件に切り詰め
 * - verified が空なら必ず空配列（「見つからない」の最終保証）
 */
export const sanitizeSuggestions = (
  proposed: readonly { stationId: number }[],
  verified: ReadonlyMap<number, StationSuggestion>
): StationSuggestion[] => {
  const out: StationSuggestion[] = [];
  const seen = new Set<number>();
  for (const p of proposed) {
    const station = verified.get(p.stationId);
    if (!station || seen.has(station.stationId)) continue;
    seen.add(station.stationId);
    out.push(station);
    if (out.length >= AGENT_MAX_SUGGESTIONS) break;
  }
  return out;
};
