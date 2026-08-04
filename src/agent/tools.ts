/**
 * 駅検索ツール — sapi-bff（BFF ルートワーカー）の GraphQL stationsByName で
 * 駅名の実在確認を行う。Service Binding（SAPI_BFF）を優先し、
 * 未設定なら SAPI_BFF_GRAPHQL_URL への fetch にフォールバックする。
 * 検索結果は verified マップへ蓄積し、最終応答のサーバ側検証
 * （validate.ts の sanitizeSuggestions）の突合元になる。
 */
import { type Tool, tool } from 'ai';
import type { Env } from '../types';
import {
  type StationSearchInput,
  type StationSuggestion,
  stationSearchInputSchema,
} from './schema';

/** stationsByName へ渡す件数（設計値。全量を返すとツール結果でトークンを浪費する） */
const STATION_SEARCH_LIMIT = 10;
/** sapi-bff 呼び出しの 1 試行あたり期限 */
const TOOL_TIMEOUT_MS = 5_000;
/** 1 ターン合計のツール呼び出し上限 */
export const MAX_TOOL_CALLS_PER_TURN = 5;
/**
 * ツール 1 回あたりの sapi-bff 呼び出し上限（表記ゆれ候補 + 一過性エラーの再試行の合計）。
 * 1 試行 5 秒のため、全体 25 秒の予算内に収まる値にする。
 */
const MAX_SEARCH_ATTEMPTS = 3;

/**
 * 上流の駅名に含まれない接尾辞（「〜駅」「... Station」など）を落とすためのパターン。
 * ラテン文字の接尾辞は必ず区切り（空白・ハイフン）を要求する。区切り無しを許すと
 * 「関（Seki）」「一ノ関（Ichinoseki）」のような実在駅名の末尾を削ってしまう。
 */
const STATION_SUFFIX_PATTERN = /(?:[\s-]+(?:station|sta\.?|eki)|\s*駅)$/i;

/** ツール結果はトークン節約のため応答スキーマと同一の軽量フィールドに絞る */
const STATIONS_BY_NAME_QUERY = `
  query AgentStationsByName($name: String!, $limit: Int, $fromStationGroupId: Int) {
    stationsByName(name: $name, limit: $limit, fromStationGroupId: $fromStationGroupId) {
      id
      groupId
      name
      nameRoman
      lines {
        nameShort
      }
    }
  }
`;

/** 現在駅の解決用。グループ内の全駅（路線別レコード）を返す */
const STATION_GROUP_STATIONS_QUERY = `
  query AgentStationGroupStations($groupId: Int!) {
    stationGroupStations(groupId: $groupId) {
      id
      groupId
      name
      nameRoman
      lines {
        nameShort
      }
    }
  }
`;

interface GqlLine {
  nameShort?: string | null;
}
interface GqlStation {
  id?: number | null;
  groupId?: number | null;
  name?: string | null;
  nameRoman?: string | null;
  lines?: GqlLine[] | null;
}

/** GraphQL の Station を提案スキーマへ詰め替える（groupId → stationGroupId に改名） */
export const toStationSuggestion = (
  s: GqlStation
): StationSuggestion | null => {
  if (typeof s.id !== 'number' || typeof s.groupId !== 'number' || !s.name) {
    return null;
  }
  return {
    stationId: s.id,
    stationGroupId: s.groupId,
    name: s.name,
    nameRoman: s.nameRoman ?? '',
    lineNames: (s.lines ?? [])
      .map((l) => l?.nameShort)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  };
};

const postGraphQL = async (
  env: Env,
  body: string,
  signal: AbortSignal
): Promise<Response> => {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal,
  };
  if (env.SAPI_BFF) {
    // Service Binding はホスト名を解決しないため URL はダミーでよい
    return env.SAPI_BFF.fetch('https://sapi-bff/graphql', init);
  }
  if (env.SAPI_BFF_GRAPHQL_URL) {
    return fetch(env.SAPI_BFF_GRAPHQL_URL, init);
  }
  throw new Error('SAPI_BFF binding or SAPI_BFF_GRAPHQL_URL is required');
};

const queryStationsOnce = async (
  env: Env,
  query: string,
  variables: Record<string, unknown>,
  field: 'stationsByName' | 'stationGroupStations',
  parentSignal: AbortSignal | undefined
): Promise<StationSuggestion[]> => {
  const controller = new AbortController();
  // abort 済みシグナルは 'abort' イベントを再発火しないため、先に状態を同期する
  if (parentSignal?.aborted) {
    controller.abort();
  }
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  // リクエスト全体の期限超過（親シグナル）もツール呼び出しへ伝播させる
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    const res = await postGraphQL(
      env,
      JSON.stringify({ query, variables }),
      controller.signal
    );
    if (!res.ok) {
      throw new Error(`${field} failed with status ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: Partial<Record<typeof field, GqlStation[] | null>> | null;
      errors?: { message?: string }[];
    };
    if (json.errors?.length) {
      throw new Error(
        `${field} GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`
      );
    }
    return (json.data?.[field] ?? [])
      .map(toStationSuggestion)
      .filter((s): s is StationSuggestion => s !== null);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
};

const searchOnce = (
  env: Env,
  name: string,
  fromStationGroupId: number | undefined,
  parentSignal: AbortSignal | undefined
): Promise<StationSuggestion[]> =>
  queryStationsOnce(
    env,
    STATIONS_BY_NAME_QUERY,
    {
      name,
      limit: STATION_SEARCH_LIMIT,
      fromStationGroupId: fromStationGroupId ?? null,
    },
    'stationsByName',
    parentSignal
  );

/**
 * 検索クエリの表記ゆれを吸収する候補を、試す順に生成する。
 * 上流の stationsByName は駅名（漢字・かな）と公式ローマ字表記への部分一致で、
 * 空白を含むクエリや「Station」付きのクエリは 0 件になる。
 * 英語会話ではモデルが "Kinugawa Onsen" / "Enoshima Station" のような
 * 分かち書きローマ字を投げがちなため、サーバ側でも救済する。
 *
 * 入力そのままを必ず最初に試す。「広島駅（Hiroshima Station）」
 * 「富山駅（Toyama Sta.）」「福井駅（Fukui-Eki）」のように、接尾辞に見える
 * 文字列が駅名そのものである実在駅があるため、正規化を先に当ててはならない。
 */
export const buildStationNameVariants = (raw: string): string[] => {
  const variants: string[] = [];
  const push = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed && !variants.includes(trimmed)) variants.push(trimmed);
  };

  const base = raw.trim().replace(/\s+/g, ' ');
  if (!base) return variants;

  // 1. 入力そのまま（正規化で実在駅名を壊さないための最優先候補）
  push(base);

  // 2. 「鎌倉駅」「Kamakura Station」など、多くの駅名には含まれない接尾辞を落とす
  const stripped = base.replace(STATION_SUFFIX_PATTERN, '').trim() || base;
  push(stripped);

  // 3. 日本語は区切り無し、ローマ字は語の区切りがハイフン（例: Kinugawa-onsen）
  if (stripped.includes(' ')) {
    const isAscii = !/[^ -~]/.test(stripped);
    push(stripped.replaceAll(' ', isAscii ? '-' : ''));
  }

  // 4. 最後の手段: 複合語は最長トークンで広く引く（例: Katase Enoshima → Enoshima）
  const tokens = stripped.split(/[\s\-・=]+/).filter((t) => t.length > 1);
  if (tokens.length > 1) {
    push(
      tokens.reduce((longest, t) => (t.length > longest.length ? t : longest))
    );
  }

  return variants;
};

/**
 * 駅名で実在駅を検索する。表記ゆれ候補を順に試し、最初に 1 件以上ヒットした
 * 結果を返す。読み取り専用で冪等のため一過性エラーは同一クエリで 1 回だけ
 * 再試行を許す（LLM 呼び出しと違いコスト重複の心配がない）。
 * 全候補が 0 件なら空配列、1 度も応答を得られなければ最後のエラーを送出する。
 */
export const searchStationsByName = async (
  env: Env,
  name: string,
  fromStationGroupId: number | undefined,
  parentSignal?: AbortSignal
): Promise<StationSuggestion[]> => {
  let lastError: unknown;
  let responded = false;
  let attempts = 0;

  for (const variant of buildStationNameVariants(name)) {
    // 同一クエリの一過性エラーは 1 回だけ再試行する
    for (let retry = 0; retry < 2 && attempts < MAX_SEARCH_ATTEMPTS; retry++) {
      attempts++;
      try {
        const stations = await searchOnce(
          env,
          variant,
          fromStationGroupId,
          parentSignal
        );
        responded = true;
        if (stations.length > 0) return stations;
        // 0 件は正常応答。再試行せず次の表記ゆれ候補へ進む
        break;
      } catch (e) {
        lastError = e;
        // リクエスト全体の期限切れなら再試行しない
        if (parentSignal?.aborted) throw e;
      }
    }
    if (attempts >= MAX_SEARCH_ATTEMPTS) break;
  }

  if (!responded && lastError) throw lastError;
  return [];
};

/**
 * 現在駅グループ ID から駅情報を 1 件に集約して返す（コンテキスト注入用）。
 * 同一グループは同名駅の路線別レコードのため、路線名を統合する。
 * 見つからなければ null。読み取り専用で冪等のため 1 回だけ再試行を許す。
 */
export const fetchStationByGroupId = async (
  env: Env,
  groupId: number,
  parentSignal?: AbortSignal
): Promise<StationSuggestion | null> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stations = await queryStationsOnce(
        env,
        STATION_GROUP_STATIONS_QUERY,
        { groupId },
        'stationGroupStations',
        parentSignal
      );
      const first = stations[0];
      if (!first) return null;
      return {
        ...first,
        lineNames: [...new Set(stations.flatMap((s) => s.lineNames))],
      };
    } catch (e) {
      lastError = e;
      // リクエスト全体の期限切れなら再試行しない
      if (parentSignal?.aborted) throw e;
    }
  }
  throw lastError;
};

/**
 * 駅検索のスコープ。上流の stationsByName は fromStationGroupId を渡すと
 * 「その駅から乗り換えなしで行ける駅」だけを返す（仕様）ため、
 * 0 件の意味とモデルへ促す次の一手がスコープごとに変わる。
 */
export type StationSearchScope =
  /** 現在駅なし: 全国から検索する */
  | 'nationwide'
  /** 現在駅あり・駅名と乗入路線も判明している */
  | 'reachable-from-known-station'
  /** 現在駅の ID だけ判明（駅情報の解決に失敗。路線名はモデルに渡っていない） */
  | 'reachable-from-unknown-station';

/** 0 件だったときにモデルへ返す次の一手（スコープごとに内容を変える） */
const NO_MATCH_NOTICE: Record<StationSearchScope, string> = {
  // 表記ゆれだけを疑わせる
  nationwide:
    'No match. Retry with the Japanese name (kanji or kana), or a shorter distinctive part of the name (e.g. an area name) with no spaces and no "Station" suffix.',
  // 0 件は「存在しない」ではなく「直通で行けない」の可能性が高い。
  // 現在駅の乗入路線はコンテキストに含まれているため、沿線での引き直しを促せる
  'reachable-from-known-station':
    'No match. Results are limited to stations reachable from the user\'s current station without a transfer, so a well-known station may simply be out of reach — this does NOT mean it does not exist. Retry with the Japanese name (kanji or kana, no spaces, no "Station" suffix), or with a different station on the current station\'s own lines or their through-services. Do not give up after one empty result.',
  // 路線名がモデルに渡っていないため、沿線での引き直しは指示できない。
  // 表記ゆれの確認と、ユーザへの確認を促す
  'reachable-from-unknown-station':
    'No match. Results are limited to stations reachable from the user\'s current station without a transfer, so a well-known station may simply be out of reach — this does NOT mean it does not exist. The current station could not be resolved, so its lines are unknown: retry with the Japanese name (kanji or kana, no spaces, no "Station" suffix), and if it is still empty, ask the user which area or line they are on instead of guessing.',
};

/** 現在駅のスコープでのみ足すツール説明（路線名を知らないケースでは案内を変える） */
const SCOPE_DESCRIPTION: Record<StationSearchScope, string | null> = {
  nationwide: null,
  'reachable-from-known-station':
    '結果は現在駅から乗り換えなしで行ける駅に限定される（仕様）。0 件は「存在しない」ではなく「直通で行けない」ことが多いため、現在駅の乗入路線・直通先の沿線にある別の駅で引き直すこと。',
  'reachable-from-unknown-station':
    '結果は現在駅から乗り換えなしで行ける駅に限定される（仕様）。0 件は「存在しない」ではなく「直通で行けない」ことが多い。現在駅の路線は不明なため、表記を変えても 0 件ならユーザにどのエリア・路線にいるかを尋ねること。',
};

/** ツール結果（駅一覧と、0 件・失敗時にモデルへ返す次の一手） */
export interface StationSearchToolResult {
  stations: StationSuggestion[];
  notice?: string;
}

export interface StationSearchToolOptions {
  /** 駅名 → 実在駅リスト（sapi-bff 呼び出し。テストでは差し替え可能） */
  search: (name: string) => Promise<StationSuggestion[]>;
  /** このターンで実在確認済みの駅（stationId → 駅）。突合検証の元データ */
  verified: Map<number, StationSuggestion>;
  /** 残りツール呼び出し回数（ターン合計 MAX_TOOL_CALLS_PER_TURN） */
  budget: { remaining: number };
  /** 検索スコープ（0 件時の案内とツール説明を切り替える） */
  scope?: StationSearchScope;
}

/** search_stations_by_name ツール定義（AI SDK 形式・プロバイダ非依存） */
export const createStationSearchTool = ({
  search,
  verified,
  budget,
  scope = 'nationwide',
}: StationSearchToolOptions): Tool<
  StationSearchInput,
  StationSearchToolResult
> =>
  tool({
    description: [
      '駅名や読みの一部から実在する駅を検索する。ユーザに駅を提案する前に必ずこのツールで実在確認すること。',
      '照合は駅名の日本語表記（漢字・かな）と公式ローマ字表記への部分一致で行う。',
      '会話が英語でも、クエリは日本語表記が最も確実（例: "Kamakura Kokomae" ではなく「鎌倉高校前」）。',
      'クエリに空白・"Station"・「駅」を含めないこと。ローマ字で検索するときは語の区切りをハイフンにする（例: Kinugawa-onsen）。',
      SCOPE_DESCRIPTION[scope],
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    inputSchema: stationSearchInputSchema,
    execute: async ({ name }): Promise<StationSearchToolResult> => {
      // 呼び出し上限超過時は検索せず、その時点の結果で応答を生成させる
      if (budget.remaining <= 0) {
        return {
          stations: [],
          notice:
            'Search limit reached. Answer using the results you already have.',
        };
      }
      budget.remaining -= 1;
      try {
        const stations = await search(name);
        for (const s of stations) {
          verified.set(s.stationId, s);
        }
        // 0 件のときは次の一手を具体的に示す（表記ゆれや到達不能で空振りし、
        // そのまま「候補が見つからない」と諦めてしまうのを防ぐ）
        if (stations.length === 0) {
          return {
            stations: [],
            notice: NO_MATCH_NOTICE[scope],
          };
        }
        return { stations };
      } catch (e) {
        // 失敗はエラーではなくツール結果として返し、モデルに正直な応答を生成させる
        console.error('agent tool: stationsByName failed', e);
        return {
          stations: [],
          notice: 'Search failed. Do not invent stations.',
        };
      }
    },
  });
