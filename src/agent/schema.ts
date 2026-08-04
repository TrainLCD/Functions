/**
 * /agent/chat の入出力スキーマ。
 * リクエスト検証（サーバ側制限の強制）と、LLM に渡すスキーマ
 * （構造化出力・ツール入力）を一元管理する。
 * LLM に渡すスキーマには min/max などプロバイダの構造化出力が
 * サポートしない制約を付けない（実在性はサーバ側の突合で担保する）。
 */
import { z } from 'zod';

/** クライアント保持の会話履歴の最大メッセージ数（サーバ側で強制） */
export const AGENT_MAX_MESSAGES = 12;
/** 1 メッセージの最大文字数（巨大入力によるコスト攻撃の防止） */
export const AGENT_MAX_MESSAGE_CHARS = 500;
/** 提案駅の最大件数 */
export const AGENT_MAX_SUGGESTIONS = 5;

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatRequestSchema = z.object({
  messages: z
    .array(chatMessageSchema)
    .min(1)
    .max(AGENT_MAX_MESSAGES)
    // 応答対象は常に最新のユーザ発話。assistant 終わりの履歴は不正とする
    .refine((msgs) => msgs[msgs.length - 1]?.role === 'user', {
      message: 'last message must be from user',
    }),
  // 端末の言語設定。応答言語は直近のユーザ発話の言語に合わせるため、これは入力から
  // 言語を判別できないときの既定と、サーバ生成の定型文（謝絶文・フォールバック文）の
  // 言語選択にしか使わない。不正値はエラーにせず日本語へフォールバックする
  locale: z.enum(['ja', 'en']).catch('ja'),
  currentStationGroupId: z.number().int().positive().optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** 提案駅。ツール結果・構造化出力・レスポンスで同じ形を使う */
export const stationSuggestionSchema = z.object({
  stationId: z.number().int(),
  stationGroupId: z.number().int(),
  name: z.string(),
  nameRoman: z.string(),
  lineNames: z.array(z.string()),
});
export type StationSuggestion = z.infer<typeof stationSuggestionSchema>;

/** LLM の最終応答（構造化出力で強制する形） */
export const agentOutputSchema = z.object({
  reply: z.string(),
  suggestions: z.array(stationSuggestionSchema),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

/** search_stations_by_name ツールの入力 */
export const stationSearchInputSchema = z.object({
  name: z
    .string()
    .describe(
      '検索する駅名（部分一致）。日本語表記（漢字・かな）が最も確実。ローマ字の場合は公式表記（語の区切りはハイフン）を使い、空白や "Station" / 「駅」は含めない'
    ),
});
export type StationSearchInput = z.infer<typeof stationSearchInputSchema>;

/** クライアントへ返すレスポンス（callable の result） */
export interface AgentChatResult {
  reply: string;
  suggestions: StationSuggestion[];
  refused: boolean;
}
