/**
 * POST /agent/chat（非ストリーミング）と POST /agent/chat/stream（SSE）—
 * AI エージェント本体。前者は callable 互換、後者は同一リクエストで SSE を返す。
 * 処理順: JWT 検証 → 入力検証 →（キルスイッチ・日次上限チェック・トピックゲート・
 * FAQ / 現在駅の解決を並列実行）→ tool use ループ（AI SDK・最大 3 イテレーション）
 * → 提案駅のサーバ側検証。
 * 前段は最初の delta までのレイテンシに直結するため、直列にせず同時に開始し、
 * 本体 LLM を呼ぶ前にキルスイッチと上限だけを必ず検証する。
 * サーバはステートレスで、会話履歴は毎回クライアントから全量を受け取る。
 */

import type { LanguageModel } from 'ai';
import { Output, stepCountIs } from 'ai';
import { verifySessionToken } from '../lib/auth/session';
import {
  type CallableCode,
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import type { Env } from '../types';
import { classifyTopic } from './gate';
import { resolveAgentModel, resolveOpenAIReasoningOptions } from './llm';
import { buildContextMessage, buildSystemPrompt, loadAgentFaq } from './prompt';
import {
  type AgentChatResult,
  type AgentOutput,
  agentOutputSchema,
  type ChatMessage,
  type ChatRequest,
  type StationSuggestion,
} from './schema';
import {
  type AgentStreamEvent,
  encodeAgentStreamEvent,
  extractReplyDelta,
} from './stream';
import {
  createStationSearchTool,
  fetchStationByGroupId,
  MAX_TOOL_CALLS_PER_TURN,
  type StationSearchScope,
  searchStationsByName,
} from './tools';
import {
  type AgentLLMRuntime,
  resolveAgentLLMRuntime,
  type StreamTextFn,
} from './tracing';
import { parseChatRequest, sanitizeSuggestions } from './validate';

/** リクエスト全体の期限（クライアントの 30 秒より短くし、サーバが先に確定応答を返す） */
const TOTAL_TIMEOUT_MS = 25_000;
/** LLM API 1 呼び出しの期限（全体 25 秒の範囲内。AI Gateway 経由のレイテンシを考慮） */
const LLM_CALL_TIMEOUT_MS = 20_000;
/** tool use ループのイテレーション上限（＋1 ステップで最終応答を生成させる） */
const MAX_TOOL_ITERATIONS = 3;
/** 出力トークン上限 */
const MAX_OUTPUT_TOKENS = 1024;
/** レート制限カウンタの TTL（日付跨ぎの猶予込みで 25 時間） */
const RATE_LIMIT_TTL_SECONDS = 25 * 60 * 60;

/** トピックゲートで謝絶したときの定型文 */
const REFUSAL_REPLY: Record<'ja' | 'en', string> = {
  ja: '申し訳ありません。行き先のご相談と TrainLCD の使い方に関するご質問のみお手伝いできます。',
  en: 'Sorry, I can only help with finding destinations and questions about how to use TrainLCD.',
};

/** モデルが応答文を返せなかったときのフォールバック */
const FALLBACK_REPLY: Record<'ja' | 'en', string> = {
  ja: '申し訳ありません。うまく応答できませんでした。もう一度お試しください。',
  en: 'Sorry, I could not generate a response. Please try again.',
};

/**
 * キルスイッチ: /config/remote と同じ KV（config:remote）の ai_agent_enabled を
 * サーバ側でも強制する。改造クライアントがフラグ配信を無視しても API 側で止まる。
 * 読んだ設定はレート制限の上限解決にも使うため返す（KV 読み取りを 1 回で済ませる）。
 */
const ensureAgentEnabled = async (
  env: Env
): Promise<Record<string, unknown>> => {
  const stored = await env.CONFIG_KV.get<Record<string, unknown>>(
    'config:remote',
    'json'
  ).catch(() => null);
  if (stored?.ai_agent_enabled !== true) {
    throw new CallableError('unavailable', 'AI agent is currently disabled');
  }
  return stored;
};

/**
 * 上限候補値を「有限かつ正の整数」へ正規化する。小数は切り捨て、
 * 結果が正の安全な整数にならない値（0 < x < 1・Infinity・負数・非数）は
 * 不正として undefined を返す（0 化して全拒否・無制限化する事故を防ぐ）。
 */
const parseDailyLimit = (value: unknown): number | undefined => {
  const limit = Math.floor(Number(value));
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
};

/**
 * 日次上限を解決する。config:remote の agent_daily_turn_limit を最優先にする
 * ことで、デプロイなしで KV から即時調整できる（キルスイッチと同じ運用感）。
 * 未設定・不正値は env var へフォールバックする。
 */
export const resolveDailyLimit = (
  env: Env,
  remoteConfig: Record<string, unknown>
): number => {
  return (
    parseDailyLimit(remoteConfig.agent_daily_turn_limit) ??
    parseDailyLimit(env.AGENT_DAILY_TURN_LIMIT) ??
    60
  );
};

/** 日次カウンタの読み取り結果（消費コミット時に current + 1 を書き込む） */
interface DailyUsage {
  key: string;
  current: number;
}

/**
 * 消費をスケジュール済みのレート制限カウンタ。ターンの途中で失敗しても
 * 呼び出し元が払い戻せるよう、戻り値ではなく共有オブジェクトで受け渡す。
 */
interface RateLimitSlot {
  key?: string;
  /** 消費（KV put）の完了。払い戻しはこれを待ってから行う */
  consumed?: Promise<void>;
}

/**
 * installId 単位の日次レート制限のチェック部分（KV get のみ）。
 * カウント消費（put）はここでは行わない。put は中央ストア書き込みで
 * 100〜300ms 級のため、全ターンの先頭に直列で入るとそのまま最初の delta までの
 * レイテンシになる。消費は本体ターン開始が確定した時点で waitUntil に逃がす
 * （commitDailyTurn 参照）。
 */
const readDailyUsage = async (
  env: Env,
  installId: string
): Promise<DailyUsage> => {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const key = `agent-rl:${installId}:${day}`;
  return { key, current: Number(await env.STATE_KV.get(key)) || 0 };
};

/**
 * 本体ターンの開始が確定した時点で持ち回数を 1 消費する。
 * KV put をレスポンス（最初の delta）の手前に置かないよう ctx.waitUntil へ逃がす。
 * 謝絶は消費前に確定するため「謝絶はターンを消費しない」挙動は払い戻し無しで保たれる。
 * 併発リクエストではチェック時点の値に +1 するため上限を僅かに超え得るが、
 * KV の結果整合を前提とした現状設計の範囲内（設計書のとおり PoC では厳密さ不要）。
 */
const commitDailyTurn = (
  env: Env,
  ctx: ExecutionContext,
  slot: RateLimitSlot,
  usage: DailyUsage
): void => {
  slot.key = usage.key;
  slot.consumed = env.STATE_KV.put(usage.key, String(usage.current + 1), {
    expirationTtl: RATE_LIMIT_TTL_SECONDS,
  }).catch((e) => {
    console.error('agent: failed to consume daily turn', e);
  });
  ctx.waitUntil(slot.consumed);
};

/**
 * 失敗ターン（エラー・タイムアウト）のカウンタ払い戻し。応答を返せていない
 * ターンで持ち回数が溶けるのを防ぐ。消費をスケジュール済みのターンだけが対象で、
 * 消費前の失敗（認証・バリデーション・キルスイッチ・上限到達）と謝絶では何もしない。
 * 同一リクエスト内では消費（waitUntil の put）の完了を待ってから読み直し、
 * 払い戻しが消費に打ち消される順序逆転を避ける。ただし KV は結果整合のため
 * put 直後の get が古い値を返すことはあり得る（現状設計の範囲内）。
 * 払い戻し自体の失敗は握って本流に影響させない。
 */
const refundDailyTurn = async (
  env: Env,
  slot: RateLimitSlot
): Promise<void> => {
  const key = slot.key;
  if (key === undefined) return;
  try {
    await slot.consumed;
    const current = Number(await env.STATE_KV.get(key)) || 0;
    if (current > 0) {
      await env.STATE_KV.put(key, String(current - 1), {
        expirationTtl: RATE_LIMIT_TTL_SECONDS,
      });
    }
  } catch (e) {
    console.error('agent: failed to refund daily turn', e);
  }
};

/** ターン終了時に 1 行で出すフェーズ別レイテンシ（ms）のキー */
type TurnPhase =
  /** JWT 検証 + 入力パース（直列・軽量） */
  | 'authParse'
  /** 並列前段のうちキルスイッチ + 日次上限チェック（KV get）の完了まで */
  | 'preflight'
  /** 並列前段のうちトピックゲート（Workers AI）の完了まで */
  | 'gate'
  /** 並列前段のうち FAQ + 現在駅の解決の完了まで */
  | 'context'
  /** 本体 LLM 開始から最初の delta まで */
  | 'firstDelta';

type TurnOutcome = 'done' | 'refused' | 'error';

/**
 * フェーズ別レイテンシの計測（新規依存なしの軽量ヘルパ）。
 * 会話本文・駅名など内容は一切保持せず、所要時間と回数だけを記録する。
 */
interface TurnMetrics {
  readonly startedAt: number;
  /** 本体 LLM 呼び出しの開始時刻（firstDelta の計測起点） */
  mainStartedAt?: number;
  toolCalls: number;
  readonly phases: Partial<Record<TurnPhase, number>>;
}

const createTurnMetrics = (): TurnMetrics => ({
  startedAt: Date.now(),
  toolCalls: 0,
  phases: {},
});

/** phase の所要時間を記録する。from 省略時はハンドラ先頭からの経過 */
const markPhase = (
  metrics: TurnMetrics,
  phase: TurnPhase,
  from: number = metrics.startedAt
): void => {
  metrics.phases[phase] = Date.now() - from;
};

/**
 * ターン終了時にフェーズ別レイテンシを 1 行の JSON で出す
 * （wrangler tail / Workers Logs でそのまま読める形）。
 * 会話本文・駅名・installId など内容・識別子は一切含めない。
 */
const logTurnMetrics = (
  metrics: TurnMetrics,
  mode: 'json' | 'sse',
  outcome: TurnOutcome
): void => {
  console.log(
    JSON.stringify({
      msg: 'agent.turn',
      mode,
      outcome,
      toolCalls: metrics.toolCalls,
      ...metrics.phases,
      total: Date.now() - metrics.startedAt,
    })
  );
};

/**
 * 検索スコープを決める。currentStationGroupId があれば上流は到達可能な駅だけを
 * 返すが、その現在駅の名称・路線まで解決できたかは別問題なので区別する。
 */
export const resolveSearchScope = (
  currentStationGroupId: number | undefined,
  currentStation: StationSuggestion | null
): StationSearchScope => {
  if (currentStationGroupId === undefined) return 'nationwide';
  return currentStation
    ? 'reachable-from-known-station'
    : 'reachable-from-unknown-station';
};

export interface AgentTurnParams {
  streamText: StreamTextFn;
  model: LanguageModel;
  systemPrompt: string;
  contextNote: string;
  messages: readonly ChatMessage[];
  locale: 'ja' | 'en';
  searchStations: (name: string) => Promise<StationSuggestion[]>;
  /** 検索スコープ（0 件時の案内とツール説明の出し分けに使う） */
  searchScope?: StationSearchScope;
  signal?: AbortSignal;
  /** reply 本文の増分（SSE の delta）。非ストリーミング呼び出しでは省略する */
  onDelta?: (text: string) => void | Promise<void>;
  /** ツール実行の開始（SSE の tool）。入力内容は会話本文相当のため渡さない */
  onToolStart?: () => void | Promise<void>;
}

/** 構造化出力を取り出せなかったときの救済用に、最終テキストを best effort で読む */
const readFinalText = async (text: PromiseLike<string>): Promise<string> => {
  try {
    return (await text) ?? '';
  } catch {
    // ストリーム自体が失敗している場合。呼び出し元が元のエラーを扱う
    return '';
  }
};

/**
 * 1 ターン分のエージェント処理（テスト可能な単位）。
 * AI SDK の tool use ループで実在確認しつつ、最終応答は構造化出力で受け取り、
 * suggestions をツール結果と突合してから返す。
 * ストリーミング／非ストリーミングで実装を分けず、イベント通知の有無だけを
 * コールバック（onDelta / onToolStart）で切り替える。
 */
export const runAgentTurn = async (
  params: AgentTurnParams
): Promise<AgentChatResult> => {
  const verified = new Map<number, StationSuggestion>();
  const budget = { remaining: MAX_TOOL_CALLS_PER_TURN };
  const openaiReasoning = resolveOpenAIReasoningOptions(params.model);

  const result = await params.streamText({
    model: params.model,
    // システムプロンプト（不変）を先頭に置き、末尾にキャッシュ境界を張る。
    // locale・現在駅などの可変要素は必ずその後ろに置く（プロンプトキャッシュ設計）
    messages: [
      {
        role: 'system',
        content: params.systemPrompt,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'system', content: params.contextNote },
      ...params.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    allowSystemInMessages: true,
    tools: {
      search_stations_by_name: createStationSearchTool({
        search: params.searchStations,
        verified,
        budget,
        scope: params.searchScope,
      }),
    },
    stopWhen: stepCountIs(MAX_TOOL_ITERATIONS + 1),
    // イテレーション上限に達したらツールを外し、その時点の結果で応答を生成させる
    prepareStep: ({ stepNumber }) =>
      stepNumber >= MAX_TOOL_ITERATIONS ? { activeTools: [] } : undefined,
    output: Output.object({ schema: agentOutputSchema }),
    // 思考（reasoning）の抑制。プロバイダは自分のキーだけを読むため、
    // 使っていない側のキーは無視される（anthropic 使用時に openai は無視、その逆も同様）
    providerOptions: {
      // Sonnet 4.6 以降は thinking 未指定だと adaptive thinking が有効になり、
      // 思考トークンがレイテンシと maxOutputTokens を消費するため明示的に無効化する
      // （Haiku 4.5 では元々思考なしのため無害）
      anthropic: { thinking: { type: 'disabled' } },
      // GPT-5 系は reasoningEffort 未指定だと既定の reasoning が各ステップの前に走り、
      // 最初の delta までのレイテンシと出力トークンを消費するため 'none' で止める。
      // ただし対応値はモデルごとに異なり、SDK はローカル検証せず API へそのまま
      // 送るため、'none' 対応が確認できるモデル以外では指定自体を省略する
      ...(openaiReasoning ? { openai: openaiReasoning } : {}),
    },
    timeout: { stepMs: LLM_CALL_TIMEOUT_MS },
    abortSignal: params.signal,
    // LLM 呼び出しはコスト重複を避けるため自動再試行しない（設計値）
    maxRetries: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // ツール入力（検索語）は会話本文相当のため送らず、実行中の合図だけを通知する
    onChunk: async ({ chunk }) => {
      if (chunk.type === 'tool-call') {
        await params.onToolStart?.();
      }
    },
  });

  // 構造化出力の partial JSON から reply の増分だけを送出する。
  // 非ストリーミング呼び出しでも同じループでストリームを消費する（実装の二重化を避ける）
  let emitted = '';
  for await (const partial of result.partialOutputStream) {
    const delta = extractReplyDelta(emitted, partial?.reply);
    if (!delta) continue;
    emitted += delta;
    await params.onDelta?.(delta);
  }

  // 構造化出力の取り出しに失敗しても、テキストがあればそれを応答として救済する
  let output: AgentOutput;
  try {
    output = await result.output;
  } catch (e) {
    const text = await readFinalText(result.text);
    // テキストも取れないのはストリーム自体の失敗なので、救済せずエラーとして扱う
    if (!text) throw e;
    // 構造化出力モードの最終テキストは JSON 表現のことがある。生の JSON を
    // 応答として見せないよう、JSON らしければ partial 抽出済みの reply で救済する
    const rescued = text.trimStart().startsWith('{') ? emitted : text;
    if (!rescued) throw e;
    output = { reply: rescued, suggestions: [] };
  }

  return {
    reply: output.reply.trim() || FALLBACK_REPLY[params.locale],
    suggestions: sanitizeSuggestions(output.suggestions ?? [], verified),
    refused: false,
  };
};

/** 前段処理の結果。謝絶なら本体 LLM を呼ばずに確定応答をそのまま返す */
type PreparedTurn =
  | { refused: AgentChatResult }
  | {
      chatReq: ChatRequest;
      faq: string | null;
      currentStation: StationSuggestion | null;
      /** 本体ターン開始時に消費する日次カウンタ（commitDailyTurn に渡す） */
      usage: DailyUsage;
    };

/**
 * ストリーミング／非ストリーミング共通の前段処理。
 * JWT 検証 → 入力検証（直列・軽量）のあと、キルスイッチ・日次上限チェック・
 * トピックゲート・FAQ / 現在駅の解決を同時に開始する。直列だと KV 2 往復と
 * Workers AI の分類（300ms〜1.5s）がそのまま最初の delta までのレイテンシに
 * 積み上がるため。両エンドポイントで同一の制約を強制する。
 */
const prepareAgentTurn = async (
  req: Request,
  env: Env,
  controller: AbortController,
  metrics: TurnMetrics
): Promise<PreparedTurn> => {
  const installId = await verifySessionToken(
    env,
    req.headers.get('Authorization')
  );
  const chatReq = parseChatRequest(await parseCallableData(req));
  markPhase(metrics, 'authParse');

  const parallelStartedAt = Date.now();

  // ここから 4 つを同時に開始する。
  // 無効化・上限到達のユーザに対してもトピック分類（Workers AI）が並行で
  // 走ってしまうが、軽量モデル 1 回かつ低頻度のため許容する。
  const enabledPromise = ensureAgentEnabled(env);
  const usagePromise = readDailyUsage(env, installId);
  const gatePromise = classifyTopic(env, chatReq.messages, controller.signal);
  // FAQ ロードと現在駅の解決（どちらも内部で catch 済みのため、
  // 謝絶時に未 await で捨てても安全）
  const contextPromise = Promise.all([
    loadAgentFaq(env),
    chatReq.currentStationGroupId === undefined
      ? Promise.resolve(null)
      : fetchStationByGroupId(
          env,
          chatReq.currentStationGroupId,
          controller.signal
        ).catch((e) => {
          console.error('agent: failed to resolve current station', e);
          return null;
        }),
  ]);

  // 先に throw した経路で残りの Promise が未処理の rejection にならないよう、
  // 監視用の catch を張っておく（値は下で元の Promise から await する）
  enabledPromise.catch(() => {});
  usagePromise.catch(() => {});
  gatePromise.catch(() => {});

  // 本体 LLM を呼ぶ前にキルスイッチと日次上限を必ず検証する
  // （ストリーム開始前なので、どちらも callable 互換の JSON エラーになる）
  const remoteConfig = await enabledPromise.catch((e) => {
    // キルスイッチ発動時、応答を返さないリクエストのために先行 I/O
    // （Workers AI の分類・現在駅解決）を走らせ続けない（各 Promise は catch 済み）
    controller.abort();
    throw e;
  });
  const usage = await usagePromise;
  if (usage.current >= resolveDailyLimit(env, remoteConfig)) {
    // 上限到達も同様に先行 I/O を打ち切る（Workers AI の呼び出しは課金対象）
    controller.abort();
    throw new CallableError(
      'resource-exhausted',
      'Daily agent turn limit reached'
    );
  }
  markPhase(metrics, 'preflight', parallelStartedAt);

  // 謝絶リクエストは本体 LLM を一切呼ばない（トークン浪費の防止）。
  // ゲートは引き続きブロッキング（並列化しても謝絶判定の位置は変えない）
  const topic = await gatePromise;
  markPhase(metrics, 'gate', parallelStartedAt);
  if (topic === 'off_topic') {
    // 先行発行済みの現在駅解決 I/O を打ち切る（両 Promise とも catch 済みのため安全）
    controller.abort();
    // 持ち回数はまだ消費していないため払い戻しは不要（謝絶はターンを消費しない）
    return {
      refused: {
        reply: REFUSAL_REPLY[chatReq.locale],
        suggestions: [],
        refused: true,
      },
    };
  }

  const [faq, currentStation] = await contextPromise;
  markPhase(metrics, 'context', parallelStartedAt);
  return { chatReq, faq, currentStation, usage };
};

/** 前段処理の結果から runAgentTurn の引数を組み立てる（両エンドポイントで共通） */
const buildTurnParams = (
  env: Env,
  runtime: AgentLLMRuntime,
  prepared: Extract<PreparedTurn, { chatReq: ChatRequest }>,
  signal: AbortSignal,
  metrics: TurnMetrics,
  callbacks: Pick<AgentTurnParams, 'onDelta' | 'onToolStart'> = {}
): AgentTurnParams => {
  const { chatReq, faq, currentStation } = prepared;
  return {
    streamText: runtime.streamText,
    model: resolveAgentModel(env),
    systemPrompt: buildSystemPrompt(faq),
    contextNote: buildContextMessage(
      chatReq.locale,
      currentStation,
      chatReq.currentStationGroupId
    ),
    messages: chatReq.messages,
    locale: chatReq.locale,
    // 検索フィルタの有無（currentStationGroupId）と、現在駅の名称・路線が
    // 解決できたかは別物。解決に失敗したときに沿線での引き直しを指示しても
    // モデルは路線名を知らないため、スコープを分けて案内を変える
    searchScope: resolveSearchScope(
      chatReq.currentStationGroupId,
      currentStation
    ),
    searchStations: (name) =>
      searchStationsByName(env, name, chatReq.currentStationGroupId, signal),
    signal,
    // 計測は内容を一切持たず、最初の delta までの所要時間とツール実行回数だけを数える
    onDelta: async (text) => {
      if (metrics.phases.firstDelta === undefined) {
        markPhase(metrics, 'firstDelta', metrics.mainStartedAt);
      }
      await callbacks.onDelta?.(text);
    },
    onToolStart: async () => {
      metrics.toolCalls += 1;
      await callbacks.onToolStart?.();
    },
  };
};

export const handleAgentChat = async (
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  // リクエスト全体の期限はハンドラ先頭から計測する
  // （JWT 検証・KV 読み書き・トピックゲートの Workers AI 呼び出しも予算に含める）
  const metrics = createTurnMetrics();
  const controller = new AbortController();
  // 期限超過の abort と、上限到達・謝絶時の先行 I/O 打ち切りの abort を区別する
  // （後者を 504（deadline-exceeded）へ誤変換しないため）
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);
  let runtime: AgentLLMRuntime | undefined;
  // 消費をスケジュール済みのレート制限カウンタ（失敗時の払い戻し先）
  const slot: RateLimitSlot = {};
  let outcome: TurnOutcome = 'error';
  try {
    runtime = resolveAgentLLMRuntime(env);
    const prepared = await prepareAgentTurn(req, env, controller, metrics);
    if ('refused' in prepared) {
      outcome = 'refused';
      return callableSuccess(prepared.refused);
    }

    // 本体ターンの開始が確定した時点で持ち回数を消費する（KV put は待たない）
    commitDailyTurn(env, ctx, slot, prepared.usage);
    metrics.mainStartedAt = Date.now();
    const result = await runAgentTurn(
      buildTurnParams(env, runtime, prepared, controller.signal, metrics)
    );
    outcome = 'done';
    return callableSuccess(result);
  } catch (e) {
    // 応答を返せなかったターン（エラー・タイムアウト）は消費済みの持ち回数を払い戻す。
    // 消費前の失敗（認証・バリデーション・キルスイッチ・上限到達）は内部で no-op になる
    ctx.waitUntil(refundDailyTurn(env, slot));
    // 期限超過はキャンセルを下流へ伝播済み。クライアントには 504 で確定応答を返す
    if (timedOut) {
      throw new CallableError('deadline-exceeded', 'Agent request timed out');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    logTurnMetrics(metrics, 'json', outcome);
    // dev 環境のみ: LangSmith トレース送信をレスポンス返却後に完了させる
    if (runtime) {
      ctx.waitUntil(runtime.flush());
    }
  }
};

/** SSE レスポンスのヘッダ（経路上でのバッファリング・変換を抑止する） */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=UTF-8',
  'cache-control': 'no-cache, no-transform',
} as const;

/** ストリーム開始後のエラーを callable のエラーコードへ写像する */
const toStreamErrorCode = (e: unknown, timedOut: boolean): CallableCode => {
  // 期限超過は非ストリーミングの 504 と同じコードで通知する
  if (timedOut) return 'deadline-exceeded';
  return e instanceof CallableError ? e.code : 'internal';
};

/**
 * POST /agent/chat/stream — /agent/chat と同一のリクエストを受け、
 * 応答を SSE（delta / tool / done / error）で配信する。
 * ストリーム開始前に判定できるエラーは callable 互換の JSON エラーで返し、
 * 開始後（200 送出後）のエラーは error イベントで通知する。
 */
export const handleAgentChatStream = async (
  req: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> => {
  const metrics = createTurnMetrics();
  const controller = new AbortController();
  // 期限超過の abort と、上限到達・謝絶時の先行 I/O 打ち切りの abort を区別する
  // （後者を deadline-exceeded へ誤変換しないため）
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);
  const slot: RateLimitSlot = {};
  const runtime = resolveAgentLLMRuntime(env);

  let prepared: PreparedTurn;
  try {
    prepared = await prepareAgentTurn(req, env, controller, metrics);
  } catch (e) {
    clearTimeout(timer);
    // 前段での失敗はまだ消費前なので払い戻しは no-op（キーが入るのは消費後だけ）
    ctx.waitUntil(refundDailyTurn(env, slot));
    ctx.waitUntil(runtime.flush());
    logTurnMetrics(metrics, 'sse', 'error');
    if (timedOut) {
      throw new CallableError('deadline-exceeded', 'Agent request timed out');
    }
    throw e;
  }

  // 謝絶でなければ本体ターンの開始が確定するため、ここで持ち回数を消費する
  // （KV put は waitUntil に逃がし、最初の delta を待たせない）
  if (!('refused' in prepared)) {
    commitDailyTurn(env, ctx, slot, prepared.usage);
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const send = async (event: AgentStreamEvent): Promise<void> => {
    await writer.write(encoder.encode(encodeAgentStreamEvent(event)));
  };

  const pump = async (): Promise<void> => {
    let outcome: TurnOutcome = 'error';
    try {
      // 謝絶は delta を出さずに確定応答だけを送る
      if ('refused' in prepared) {
        outcome = 'refused';
        await send({ event: 'done', data: prepared.refused });
        return;
      }
      metrics.mainStartedAt = Date.now();
      const result = await runAgentTurn(
        buildTurnParams(env, runtime, prepared, controller.signal, metrics, {
          onDelta: (text) => send({ event: 'delta', data: { text } }),
          onToolStart: () => send({ event: 'tool', data: {} }),
        })
      );
      outcome = 'done';
      await send({ event: 'done', data: result });
    } catch (e) {
      // ストリーム開始後に失敗したターンも、非ストリーミングと同じ基準で払い戻す
      await refundDailyTurn(env, slot);
      const code = toStreamErrorCode(e, timedOut);
      if (code === 'internal') {
        console.error('agent: stream turn failed', e);
      }
      // クライアント切断などで送出自体が失敗しても、ここでは何もできない
      await send({ event: 'error', data: { code } }).catch(() => {});
    } finally {
      clearTimeout(timer);
      logTurnMetrics(metrics, 'sse', outcome);
      // done / error のあとはストリームを閉じる（クライアントは終端で受信を終える）
      await writer.close().catch(() => {});
      // dev 環境のみ: LangSmith トレース送信をストリーム終了後に完了させる
      await runtime.flush();
    }
  };

  ctx.waitUntil(pump());
  return new Response(readable, { status: 200, headers: SSE_HEADERS });
};
