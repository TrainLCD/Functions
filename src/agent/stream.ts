/**
 * POST /agent/chat/stream の SSE 表現（純関数）。
 * I/O を持つハンドラ本体から切り離し、イベントのエンコードと
 * partial JSON から増分テキストを取り出す処理だけを担う。
 */
import type { AgentChatResult } from './schema';

/**
 * SSE で送出するイベント。クライアントは未知のイベント名を無視する
 * （前方互換）ため、追加時は既存イベントの意味を変えないこと。
 * - delta: reply 本文の増分
 * - tool: ツール実行中の合図（入力内容は会話本文相当のため送らない）
 * - done: 最終確定応答（非ストリーミングの result と同一形）
 * - error: ストリーム開始後のエラー（callable のエラーコード）
 */
export type AgentStreamEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool'; data: Record<string, never> }
  | { event: 'done'; data: AgentChatResult }
  | { event: 'error'; data: { code: string } };

/**
 * SSE の 1 イベントを組み立てる。JSON.stringify は文字列中の改行を
 * エスケープするため data は必ず 1 行に収まり、data 行の分割は考えなくてよい。
 */
export const encodeAgentStreamEvent = (event: AgentStreamEvent): string =>
  `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

/**
 * partial JSON 由来の reply から、まだ送出していない増分だけを取り出す。
 * 送出済みテキストが partial の接頭辞である場合のみ差分を返し、値が縮んだ・
 * 別の値へ分岐した場合は空文字を返す（誤った本文を delta として送らない）。
 * ここでの取りこぼしは、クライアントが done の確定値で置き換えて補正する。
 */
export const extractReplyDelta = (
  emitted: string,
  partialReply: unknown
): string => {
  if (typeof partialReply !== 'string') return '';
  // startsWith は「縮んだ」ケース（partialReply が emitted より短い）も弾く
  if (!partialReply.startsWith(emitted)) return '';
  return partialReply.slice(emitted.length);
};
