/**
 * 対話本体の LLM プロバイダ解決。
 * AGENT_MODEL（"anthropic:<model>" | "openai:<model>" | "google:<model>"）で
 * モデルを切り替え、AI_GATEWAY_BASE_URL が設定されていれば Cloudflare AI Gateway を
 * 経由させる（ログ・コスト集計・レート制限を Cloudflare 側に集約）。
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createVertex } from '@ai-sdk/google-vertex/edge';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { Env } from '../types';

// AI Gateway 経由時も会話本文をゲートウェイのログに保存させない（設計: プライバシー）
const GATEWAY_HEADERS = { 'cf-aig-collect-log-payload': 'false' } as const;

/** Vertex のロケーション既定。global はモデルの提供範囲が最も広く、Gateway 経由でも中継される */
const DEFAULT_VERTEX_LOCATION = 'global';

interface VertexCredentials {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  projectId?: string;
}

/**
 * GOOGLE_VERTEX_SA_KEY（サービスアカウント鍵 JSON）を資格情報に変換する。
 * Vertex AI は API キーではなく ADC（サービスアカウント）認証が前提だが、Workers に
 * ADC は無いため鍵の中身を渡し、JWT 署名とトークン交換は SDK の edge 版に行わせる。
 */
const parseVertexCredentials = (keyJson: string): VertexCredentials => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(keyJson) as Record<string, unknown>;
  } catch {
    throw new Error('GOOGLE_VERTEX_SA_KEY is not valid JSON');
  }
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
    throw new Error(
      'GOOGLE_VERTEX_SA_KEY must contain client_email and private_key'
    );
  }
  return {
    clientEmail,
    // 1 行 JSON で投入された鍵は改行がエスケープされたままのことがあるため戻す
    privateKey: privateKey.replace(/\\n/g, '\n'),
    privateKeyId:
      typeof parsed.private_key_id === 'string'
        ? parsed.private_key_id
        : undefined,
    projectId:
      typeof parsed.project_id === 'string' ? parsed.project_id : undefined,
  };
};

/** AGENT_MODEL の指定から AI SDK のモデルを生成する。 */
export const resolveAgentModel = (env: Env): LanguageModel => {
  const spec = env.AGENT_MODEL ?? '';
  const sep = spec.indexOf(':');
  const provider = sep === -1 ? '' : spec.slice(0, sep);
  const modelId = spec.slice(sep + 1);
  // 末尾スラッシュの揺れを吸収。空文字なら Gateway を使わず各社 API 直行
  const gateway = env.AI_GATEWAY_BASE_URL?.replace(/\/+$/, '') || undefined;

  switch (provider) {
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
      }
      const anthropic = createAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        ...(gateway
          ? {
              baseURL: `${gateway}/anthropic/v1`,
              headers: { ...GATEWAY_HEADERS },
            }
          : {}),
      });
      return anthropic(modelId);
    }
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not configured');
      }
      const openai = createOpenAI({
        apiKey: env.OPENAI_API_KEY,
        ...(gateway
          ? { baseURL: `${gateway}/openai`, headers: { ...GATEWAY_HEADERS } }
          : {}),
      });
      return openai(modelId);
    }
    // Gemini は Vertex AI（サービスアカウント認証）経由で使う。
    // Google AI Studio の API キー方式は使わないため "google:" は Vertex を指す
    case 'google': {
      if (!env.GOOGLE_VERTEX_SA_KEY) {
        throw new Error('GOOGLE_VERTEX_SA_KEY is not configured');
      }
      const credentials = parseVertexCredentials(env.GOOGLE_VERTEX_SA_KEY);
      // プロジェクトは鍵の project_id を既定にし、別プロジェクトを使うときだけ var で上書きする
      const project = env.GOOGLE_VERTEX_PROJECT || credentials.projectId;
      if (!project) {
        throw new Error('GOOGLE_VERTEX_PROJECT is not configured');
      }
      const location = env.GOOGLE_VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION;
      const vertex = createVertex({
        project,
        location,
        googleCredentials: {
          clientEmail: credentials.clientEmail,
          privateKey: credentials.privateKey,
          privateKeyId: credentials.privateKeyId,
        },
        ...(gateway
          ? {
              // Gateway は google-vertex-ai 配下のパスをそのまま Vertex へ中継する。
              // API バージョンは直行時の SDK 既定（v1beta1）に合わせ、Gateway の
              // 有無で挙動が変わらないようにする
              baseURL: `${gateway}/google-vertex-ai/v1beta1/projects/${project}/locations/${location}/publishers/google`,
              headers: { ...GATEWAY_HEADERS },
            }
          : {}),
      });
      return vertex(modelId);
    }
    default:
      throw new Error(
        `unsupported AGENT_MODEL: "${spec}" (expected "anthropic:<id>", "openai:<id>" or "google:<id>")`
      );
  }
};

/** LanguageModel（文字列指定・インスタンスのどちらも来る）からモデル ID を取り出す。 */
const modelIdOf = (model: LanguageModel): string =>
  typeof model === 'string' ? model : model.modelId;

/**
 * reasoningEffort: 'none' を受け付ける OpenAI モデル（GPT-5.1 系以降の
 * マイナーバージョン付き GPT-5）。gpt-5 無印（'minimal' まで）・o 系
 * （low/medium/high のみ）・非 reasoning モデル（パラメータ自体を拒否）へ
 * 'none' を送ると API エラー（400）になる。
 */
const OPENAI_REASONING_NONE_MODELS = /^gpt-5\.[1-9]/;

/**
 * OpenAI 向け reasoning 抑制の providerOptions をモデル別に解決する。
 * AGENT_MODEL は任意の "openai:<model>" を受け付けるため、'none' 対応が
 * 確認できているモデルに限って指定し、それ以外では省略する（非対応モデルへの
 * 誤指定で全リクエストが失敗するより、既定 reasoning のレイテンシを許容する）。
 */
export const resolveOpenAIReasoningOptions = (
  model: LanguageModel
): { reasoningEffort: 'none' } | undefined =>
  OPENAI_REASONING_NONE_MODELS.test(modelIdOf(model))
    ? { reasoningEffort: 'none' }
    : undefined;

/** 思考を完全に止められる Gemini（2.5 系は thinkingBudget: 0 が通る） */
const GEMINI_THINKING_OFF_MODELS = /^gemini-2\.5/;
/** thinkingLevel で思考量を指定する Gemini（3 系以降） */
const GEMINI_THINKING_LEVEL_MODELS = /^gemini-[3-9]/;

/**
 * Gemini 向けの reasoning 抑制を AI SDK 共通の reasoning 設定として解決する。
 * Gemini は世代で送るパラメータが異なる（3 系: thinkingLevel / 2.5 系:
 * thinkingBudget）ため、providerOptions.google を自前で組まず SDK に変換させる。
 *
 * 3 系で 'none' を使わないのは、SDK が thinkingLevel: 'minimal' に変換する一方、
 * Vertex がこれを拒否する（400 "Thinking level is unsupported:
 * THINKING_LEVEL_MINIMAL"）ため。受理される最小値の 'low' まで下げる。
 * 2.0 系や gemini-flash-latest のようなエイリアスは指定自体を省略する。
 */
export const resolveGoogleReasoningSetting = (
  model: LanguageModel
): 'none' | 'low' | undefined => {
  const modelId = modelIdOf(model);
  if (GEMINI_THINKING_OFF_MODELS.test(modelId)) return 'none';
  if (GEMINI_THINKING_LEVEL_MODELS.test(modelId)) return 'low';
  return undefined;
};
