/**
 * AI生成レポートの型定義
 */
export const AI_CATEGORIES = [
  'bug',
  'feature_request',
  'improvement',
  'question',
  /** 感謝・称賛・応援。対応は不要だがスパムではない */
  'praise',
] as const;
export type AICategory = (typeof AI_CATEGORIES)[number];

export const AI_TRIAGE_LEVELS = ['urgent', 'high', 'medium', 'low'] as const;
export type AITriageLevel = (typeof AI_TRIAGE_LEVELS)[number];

/**
 * 原因があると推定されるコンポーネント。公開リポジトリへの起票先の決定に使う。
 * 特定できない場合は AIReport.component が null になる。
 */
export const AI_COMPONENTS = [
  'mobile_app',
  'station_api',
  'functions',
  'website',
] as const;
export type AIComponent = (typeof AI_COMPONENTS)[number];

export type AIReport = {
  /** レポートのタイトル */
  title: string;
  /** レポートの要約 */
  summary: string;
  /** スパム判定フラグ */
  isSpam: boolean;
  /** ラベルのリスト（例: 'bug', 'feature-request' など） */
  labels: string[];
  /** 信頼度スコア (0.0 - 1.0) */
  confidence: number;
  /** 分類理由 */
  reason: string;
  /** 主分類カテゴリ */
  category: AICategory;
  /** トリアージ（優先度）レベル */
  triageLevel: AITriageLevel;
  /** 原因があると推定されるコンポーネント（特定できなければ null） */
  component: AIComponent | null;
  /** component の推定信頼度 (0.0 - 1.0)。component が null のときは 0 */
  componentConfidence: number;
};

export type FewShotItem = {
  input: string;
  output: string;
  disabled?: boolean;
  weight?: number;
};
