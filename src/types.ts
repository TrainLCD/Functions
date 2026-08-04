/**
 * Worker のバインディング・環境変数・シークレットの型定義。
 * wrangler.jsonc の bindings / vars と一致させること。
 */
export interface Env {
  // --- Bindings ---
  AI: Ai;
  TTS_KV: KVNamespace;
  CONFIG_KV: KVNamespace;
  STATE_KV: KVNamespace;
  TTS_BUCKET: R2Bucket;
  UPLOAD_BUCKET: R2Bucket;
  FEEDBACK_QUEUE: Queue<FeedbackQueueMessage>;
  /** sapi-bff（BFF ルートワーカー）への Service Binding。エージェントの駅検索に使う */
  SAPI_BFF?: Fetcher;

  // --- Vars（非機密。wrangler.jsonc の vars） ---
  GOOGLE_PLAY_PACKAGE_NAME: string;
  AZURE_SPEECH_REGION: string;
  AI_TRIAGE_MODEL: string;
  TTS_JA_VOICE_NAME: string;
  TTS_EN_VOICE_NAME: string;
  SESSION_TOKEN_TTL_SECONDS: string;
  UPLOAD_PUBLIC_BASE_URL: string;
  FEW_SHOT_KV_KEY: string;
  FEW_SHOT_LIMIT: string;
  FEW_SHOT_PER_EX_MAX: string;
  /** 対話本体モデル（"anthropic:<model>" | "openai:<model>"） */
  AGENT_MODEL: string;
  /** トピックゲート用の Workers AI モデル */
  AGENT_GATE_MODEL: string;
  /** 使い方 FAQ を置く CONFIG_KV のキー */
  AGENT_FAQ_KV_KEY: string;
  /** 1 ユーザ（installId）あたりの日次ターン上限（config:remote の agent_daily_turn_limit が優先） */
  AGENT_DAILY_TURN_LIMIT: string;
  /** Cloudflare AI Gateway のベース URL（空なら各社 API 直行） */
  AI_GATEWAY_BASE_URL?: string;
  /** Service Binding 不使用時の sapi-bff GraphQL エンドポイント */
  SAPI_BFF_GRAPHQL_URL?: string;
  /** "true" で LangSmith トレーシングを有効化（dev 環境のみ設定すること） */
  LANGSMITH_TRACING?: string;

  // --- Secrets（wrangler secret put で投入） ---
  SESSION_JWT_SECRET: string;
  AZURE_SPEECH_KEY: string;
  /** Android Publisher 用 Google サービスアカウント鍵 JSON 文字列 */
  GOOGLE_PLAY_SA_KEY: string;
  /** App Store Connect API 鍵 JSON 文字列 ({keyId, issuerId, privateKey}) */
  APPSTORE_CONNECT_KEY: string;
  OCTOKIT_PAT: string;
  DISCORD_CS_WEBHOOK_URL: string;
  DISCORD_CRASH_WEBHOOK_URL: string;
  DISCORD_REVIEW_WEBHOOK_URL: string;
  /** 対話本体（Claude）の API キー。AGENT_MODEL が anthropic: のとき必須 */
  ANTHROPIC_API_KEY?: string;
  /** 対話本体（GPT）の API キー。AGENT_MODEL が openai: のとき必須 */
  OPENAI_API_KEY?: string;
  /** LangSmith の API キー（dev 環境のトレーシング用・任意） */
  LANGSMITH_API_KEY?: string;

  // --- Azure TTS チューニング（任意。未設定なら高音質既定のみ適用） ---
  AZURE_TTS_OUTPUT_FORMAT?: string;
  AZURE_TTS_STYLE?: string;
  AZURE_TTS_STYLE_DEGREE?: string;
  AZURE_TTS_PITCH?: string;

  // --- 任意のデバッグ変数（未設定可） ---
  REVIEWS_DEBUG?: string;
  REVIEWS_DRY_RUN?: string;
  REVIEWS_FORCE_LATEST_COUNT?: string;
  APPSTORE_APP_ID?: string;
}

/** TTS キャッシュ書き込みのペイロード（R2+KV へ直接保存。キューは介さない） */
export interface TtsCachePayload {
  id: string;
  jaAudioContent: string;
  enAudioContent: string;
  jaAudioMimeType: string;
  enAudioMimeType: string;
  ssmlJa: string;
  ssmlEn: string;
  voiceJa: string;
  voiceEn: string;
}

/** feedback-triage キューのメッセージ */
export interface FeedbackQueueMessage {
  id: string;
  receivedAt: string;
  report: import('./models/feedback').Report;
  version: number;
}
