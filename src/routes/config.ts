/**
 * GET /config/maintenance, GET /config/remote — KV 配信のアプリ設定。
 * Firestore(appConfig/maintenance) と Remote Config の代替。認証不要。
 */
import type { Env } from '../types';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=UTF-8',
  // 起動時 1 回取得 + 端末キャッシュ運用。エッジでも短時間キャッシュ。
  'cache-control': 'public, max-age=60',
};

interface MaintenanceConfig {
  underMaintenance: boolean;
}

type Primitive = string | number | boolean;

interface RemoteConfig {
  max_permit_accuracy: number;
  force_not_arrived_on_low_accuracy: boolean;
  eta_assist_enabled: boolean;
  /** AI エージェント（/agent/chat）のキルスイッチ。既定 false */
  ai_agent_enabled: boolean;
}

// 既知キーは型を保持し、欠損時はクライアント側の既定値に委ねる。
// 未知の将来キーはプリミティブ値に限ってパススルーする。
type RemoteConfigResponse = Partial<RemoteConfig> & Record<string, Primitive>;

const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isValidRemoteConfigEntry = (
  key: string,
  value: unknown
): value is Primitive => {
  if (!isPrimitive(value)) {
    return false;
  }

  switch (key) {
    case 'max_permit_accuracy':
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    case 'force_not_arrived_on_low_accuracy':
    case 'eta_assist_enabled':
    case 'ai_agent_enabled':
      return typeof value === 'boolean';
    default:
      return true;
  }
};

/**
 * KV の config:remote を返す。既知キーは型と範囲を検証し、未知の将来キーは
 * プリミティブ（string / number / boolean）のみパススルーする。
 * 不正値は捨て、クライアント側の既定値にフォールバックさせる。
 * stored がオブジェクトでない（null / 壊れた JSON / 配列など）場合は空 {} を返す。
 */
export const mergeRemoteConfig = (stored: unknown): RemoteConfigResponse => {
  const merged: RemoteConfigResponse = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      if (isValidRemoteConfigEntry(key, value)) {
        merged[key] = value;
      }
    }
  }
  return merged;
};

export const handleMaintenanceConfig = async (env: Env): Promise<Response> => {
  // KV 値が壊れた JSON だと get が例外を投げるため、フォールバックで握る
  const stored = await env.CONFIG_KV.get<MaintenanceConfig>(
    'config:maintenance',
    'json'
  ).catch(() => null);
  const body: MaintenanceConfig = {
    underMaintenance: stored?.underMaintenance === true,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
  });
};

export const handleRemoteConfig = async (env: Env): Promise<Response> => {
  // KV の JSON は任意の形の外部入力なので unknown で受け（壊れた JSON は
  // get が例外を投げるため .catch で握る）、mergeRemoteConfig 側で検証する。
  const stored = await env.CONFIG_KV.get<unknown>(
    'config:remote',
    'json'
  ).catch(() => null);
  const body = mergeRemoteConfig(stored);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
  });
};
