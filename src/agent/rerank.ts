/**
 * 提案駅のリランク — ツール結果（実在確認済みの候補）のうち、どれがユーザの要望に
 * 合っているかを TypeSafe（System One / Jev）の noul で判定する。
 *
 * TypeSafe は判定しか返さず文章生成をしない（<https://docs.typesafe.ai/api>）ので、
 * ここが決めるのは「どの駅か」だけ。候補を思いつく（世界知識）のと本文を書くのは
 * 対話本体の LLM が担い続ける。
 *
 * # フィードバックのトリアージとは別物
 *
 * 同じ API を叩くが、失敗したときにすべきことが正反対のため実装を共有しない。
 * トリアージはキューのコンシューマで動き、1 件も落とせないので粘って再試行し、
 * 最後は throw して DLQ に残す。こちらはライブの HTTP リクエスト（ターン全体
 * 25 秒）の中で動き、遅延がそのままユーザの待ち時間になる。判定は「あると嬉しい」
 * ものでしかないので、
 *
 *   - 再試行しない（待つならその時間は本文のストリーミングに使うべき）
 *   - 例外を外に出さない。失敗は null で返し、呼び出し側は LLM 側の順序に倒す
 *
 * という設計にする。トリアージ側の再試行方針をこちらに持ち込んではならない。
 *
 * # 閾値は未フィッティング
 *
 * 採用する閾値は計測（src/cli/typesafe-rerank-spike.ts）で決める。既定値を置くと
 * 測る前に本番へ出る道ができてしまうため、selectSuggestions は閾値を必須引数で
 * 受け取る。
 */
import { AGENT_MAX_SUGGESTIONS, type StationSuggestion } from './schema';

const API_URL = 'https://api.typesafe.ai/v1/systemone';

/** 判定に渡す候補の上限。1 ターンのツール結果が数十件になり得るため天井を置く */
export const MAX_JUDGED_CANDIDATES = 30;

/**
 * このモジュールが使う TypeSafe の型は noul だけ。choice / score は使わないので
 * 定義も持たない（使う形だけを持つことで、他用途への流用を誘わない）。
 */
type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
};

type SystemOneResult = {
  answers: Record<string, { type?: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/** 判定の材料。直近のユーザ発話と、相対表現の解釈に必要な現在駅 */
export type RerankInput = {
  /** 直近のユーザ発話（要望そのもの） */
  request: string;
  /** 現在駅の駅名。「近く」「ここから」の解釈に使う。不明なら null */
  currentStationName: string | null;
};

export type CandidateScore = {
  station: StationSuggestion;
  /** 要望を満たす確率（0〜1） */
  fits: number;
};

/**
 * 候補 1 件が要望に合っているかを問う。
 *
 * 命令・基準は日本語で書く。判定対象が日本語の要望文と日本の駅名で、英語に
 * 置き換えると「海が見える」「下町の雰囲気」のような要望の輪郭がぼやけるため
 * （トリアージ側の質問定義と同じ判断）。
 *
 * 基準は候補同士を比べない書き方にしてある。候補ごとに独立して評価される
 * （案 X）場合、比較を求める基準は答えられないため。
 */
const FITS_INSTRUCTIONS =
  '`candidate` の駅は、`request` の要望に対する行き先として妥当か。';

const FITS_CRITERIA = {
  true: '要望が挙げている条件（地名・目的・景色・施設・雰囲気）に、この駅が実際に当てはまる。要望が特定の駅を指しているなら、その駅そのもの。',
  false:
    '要望の条件に当てはまらない。名前や読みが要望の語と似ているだけで別の場所にある駅、要望と無関係な地域の駅、条件を満たさない駅。',
} as const;

const fitsQuestion = (candidatePath: string): NoulQuestion => ({
  type: 'noul',
  // 参照する候補の位置だけを差し替える。命令と基準は全候補で同一にする
  instructions: FITS_INSTRUCTIONS.replace(
    '`candidate`',
    `\`${candidatePath}\``
  ),
  criteria: FITS_CRITERIA,
});

/** state に載せる候補の形。判定に効かないフィールド（ID）は渡さない */
const toCandidateState = (station: StationSuggestion) => ({
  name: station.name,
  name_roman: station.nameRoman,
  lines: station.lineNames,
});

const baseState = (input: RerankInput): Record<string, unknown> => ({
  request: input.request,
  ...(input.currentStationName
    ? { current_station: input.currentStationName }
    : {}),
});

/**
 * 案 X: 候補ごとに 1 リクエスト。
 * rerank cookbook（<https://docs.typesafe.ai/cookbooks/rerank_typesafe>）準拠で、
 * 各問が 1 候補しか見ないため候補同士の比較効果が入らない。state を候補数ぶん
 * 払うのでトークンは案 Y より高い。
 */
export const buildIsolatedRequests = (
  input: RerankInput,
  candidates: readonly StationSuggestion[]
): {
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
}[] =>
  candidates.map((station) => ({
    state: { ...baseState(input), candidate: toCandidateState(station) },
    questions: { fits: fitsQuestion('candidate') },
  }));

/**
 * 案 Y: 全候補を 1 リクエストに集約。
 * state を 1 回しか払わないためトークンが安い。質問は互いに独立で並列に評価
 * されるが、各問が候補一覧全体を見る点が案 X と違う。どちらが精度で勝つかは
 * 計測で決める。
 */
export const buildBatchedRequest = (
  input: RerankInput,
  candidates: readonly StationSuggestion[]
): {
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
} => {
  const questions: Record<string, NoulQuestion> = {};
  candidates.forEach((_, index) => {
    questions[questionId(index)] = fitsQuestion(`candidates[${index}]`);
  });
  return {
    state: {
      ...baseState(input),
      candidates: candidates.map(toCandidateState),
    },
    questions,
  };
};

/** 案 Y の質問 ID。回答を候補の添字へ戻すために使う */
export const questionId = (index: number): string => `fits_${index}`;

export type JudgeOptions = {
  apiKey: string;
  model: string;
  /** 案 X（候補ごと）か案 Y（1 リクエストに集約）か */
  shape: 'isolated' | 'batched';
  signal?: AbortSignal;
  /** 計測用。使用トークンを受け取る */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
};

/**
 * TypeSafe へ 1 リクエスト投げる。再試行はしない。失敗（HTTP エラー・ネットワーク
 * 断・JSON 破損・中断）はすべて null に落とし、例外を外へ出さない。
 */
const requestSystemOne = async (
  body: unknown,
  options: JudgeOptions
): Promise<SystemOneResult | null> => {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!res.ok) {
      // 本文はログに出さない（会話本文由来の情報が混ざり得る）
      console.warn(`agent rerank: TypeSafe API ${res.status}`);
      return null;
    }
    return (await res.json()) as SystemOneResult;
  } catch (e) {
    // エラーオブジェクトをそのまま出さない。JSON 破損時の SyntaxError.message は
    // 応答本文の先頭を含む（例: `Unexpected token 'o', "not json" is not valid JSON`）
    // ため、!res.ok 側で本文を出さないようにした意図がここで破れる。
    // 種別（AbortError / TypeError / SyntaxError）だけで運用上は足りる。
    console.warn(
      `agent rerank: TypeSafe API の呼び出しに失敗した (${kindOf(e)})`
    );
    return null;
  }
};

/**
 * エラーの種別だけを取り出す。`instanceof Error` は使わない。fetch / Response の
 * 実装が別 realm の Error を投げると false になり（Jest の node 環境で実際に
 * SyntaxError が取れず `object` に落ちた）、種別が分からないログになる。
 */
const kindOf = (e: unknown): string => {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : typeof e;
};

/** 回答から noul を取り出す。型が合わない・範囲外は null */
const readNoul = (answer: { type?: string; noul?: number } | undefined) => {
  if (!answer || answer.type !== 'noul') return null;
  const { noul } = answer;
  return typeof noul === 'number' && noul >= 0 && noul <= 1 ? noul : null;
};

/**
 * 候補を判定する。
 *
 * **全候補を判定できたときだけ結果を返す。1 件でも判定できなければ null。**
 * 判定できなかった候補を黙って落とすと、戻り値は「完全な判定結果」として扱われ、
 * その候補は閾値以上でも提案から確実に除外される。案 X は候補ごとに並列で投げる
 * ので、レート制限（429）に当たるのがどの候補かは着順で決まり、同じ会話でも
 * 提案が揺れることになる。再試行しない設計なので回復経路も無い。
 *
 * null のときの代償はリランクを丸ごと捨てて LLM 側の順序に倒すことで、これは
 * 今の本番挙動そのものなので劣化にならない。「落としてよい」のはリランクの結果
 * 全体であって、個々の候補ではない。
 *
 * 戻り値の意味:
 *   null … 判定できなかった（呼び出し側は LLM 側の順序に倒す）
 *   []   … 判定した結果、候補が 0 件だった（要望に合う駅が無いとは別。閾値は
 *          selectSuggestions が当てる）
 */
export const judgeCandidates = async (
  input: RerankInput,
  candidates: readonly StationSuggestion[],
  options: JudgeOptions
): Promise<CandidateScore[] | null> => {
  const targets = candidates.slice(0, MAX_JUDGED_CANDIDATES);
  if (targets.length === 0) return [];

  const usage = { inputTokens: 0, outputTokens: 0 };
  const collect = (results: readonly (SystemOneResult | null)[]) => {
    for (const result of results) {
      usage.inputTokens += result?.usage?.input_tokens ?? 0;
      usage.outputTokens += result?.usage?.output_tokens ?? 0;
    }
  };

  /** 候補の添字 → その候補の回答を含む応答。判定できない候補があれば null */
  let fitsByIndex: (number | null)[];

  if (options.shape === 'batched') {
    const { state, questions } = buildBatchedRequest(input, targets);
    const result = await requestSystemOne(
      { state, model: options.model, questions },
      options
    );
    collect([result]);
    // 使用トークンは null を返す場合でも報告する（計測でコストを取り落とさない）
    options.onUsage?.(usage);
    if (!result) return null;
    fitsByIndex = targets.map((_, index) =>
      readNoul(result.answers?.[questionId(index)])
    );
  } else {
    const requests = buildIsolatedRequests(input, targets);
    const results = await Promise.all(
      requests.map(({ state, questions }) =>
        requestSystemOne({ state, model: options.model, questions }, options)
      )
    );
    collect(results);
    options.onUsage?.(usage);
    fitsByIndex = results.map((result) => readNoul(result?.answers?.fits));
  }

  const scores: CandidateScore[] = [];
  for (const [index, station] of targets.entries()) {
    const fits = fitsByIndex[index];
    if (fits === null || fits === undefined) return null;
    scores.push({ station, fits });
  }
  return scores;
};

/**
 * 判定結果から提案駅を選ぶ。確率の降順に並べ、閾値未満を落とし、同一物理駅を
 * 1 件に畳んでから上限件数で切る。同じ確率のときは判定に渡した順（＝ツール結果の
 * 順）を保つ。
 *
 * `stationGroupId` で畳むのが要点。`stationsByName` は同一物理駅を路線別レコード
 * （別 stationId・同一 groupId）で返すため、畳まずに確率順で切ると枠が同じ駅で
 * 埋まる。実測（案 Y）では「海が見える駅」の上位 5 件が熱海の 4 レコードと真鶴に
 * なり、根府川と早川が押し出された。アプリ側は受け取った提案を groupId で畳む
 * （`dedupeStationsByGroupId`）ので、そのままでは提案カードが 2 枚に減る。
 * 実在性検証の `sanitizeSuggestions` は stationId しか見ないため、ここで畳む。
 *
 * threshold は既定値を持たない。計測で決めるまで本番に出せないようにするため。
 */
export const selectSuggestions = (
  scores: readonly CandidateScore[],
  threshold: number,
  max: number = AGENT_MAX_SUGGESTIONS
): StationSuggestion[] => {
  const ranked = scores
    .map((score, index) => ({ score, index }))
    .filter(({ score }) => score.fits >= threshold)
    .sort((a, b) => b.score.fits - a.score.fits || a.index - b.index);

  const seenGroups = new Set<number>();
  const picked: StationSuggestion[] = [];
  for (const { score } of ranked) {
    const { stationGroupId } = score.station;
    // 同一物理駅は最も確率の高いレコードだけを残す
    if (seenGroups.has(stationGroupId)) continue;
    seenGroups.add(stationGroupId);
    picked.push(score.station);
    if (picked.length >= max) break;
  }
  return picked;
};

/**
 * 有効化と閾値は `config:remote` の `agent_rerank_threshold` で決める
 * （キルスイッチ・日次上限と同じ運用感でデプロイなしに切り替えられる）。
 * 0 より大きく 1 以下の数値のときだけ有効。未設定・不正値は無効（null）。
 *
 * 既定値をコードに持たない。実測（2026-09-18・案 Y・20 項目）では 0.70 が
 * reject 違反 0・recall 17/19・「合う駅なし」4/4 を満たす最小値だったが、
 * 20 項目に対するグリッド最良値なので、値は KV 側で持って調整する。
 */
export const resolveRerankThreshold = (
  remoteConfig: Record<string, unknown>
): number | null => {
  const value = Number(remoteConfig.agent_rerank_threshold);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
};

/** 判定結果を提案駅へ落とすところまでをまとめた関数。null は「判定できなかった」 */
export type RerankSelector = (
  input: RerankInput,
  candidates: readonly StationSuggestion[]
) => Promise<StationSuggestion[] | null>;

/** 対話ターンから使う形。無効時は呼び出し側が null を渡して分岐を消す */
export const createRerankSelector = (config: {
  apiKey: string;
  model: string;
  threshold: number;
  signal?: AbortSignal;
}): RerankSelector => {
  return async (input, candidates) => {
    const scores = await judgeCandidates(input, candidates, {
      apiKey: config.apiKey,
      model: config.model,
      // 実測で案 X（候補ごと）に全指標で勝ち、トークンは 55%、レイテンシは 65% だった
      shape: 'batched',
      signal: config.signal,
    });
    return scores === null ? null : selectSuggestions(scores, config.threshold);
  };
};

/**
 * 提案してよい駅を対話本体へ伝える system メッセージ本文。
 *
 * 判定結果でモデルの出力スキーマを置き換えるのではなく、**本文を書く前に
 * 提案集合を渡す**形にしてある。こうすると reply が提案集合に条件付けられるので
 * 本文と提案カードが食い違わず、判定できなかったとき（null）は何も注入せず
 * 今と同じ挙動（モデルが自分で選ぶ）にフォールバックできる。
 */
export const buildRerankNote = (
  picked: readonly StationSuggestion[]
): string => {
  if (picked.length === 0) {
    return [
      '# 提案してよい駅',
      '',
      'ツール結果を精査したが、ユーザの要望を満たす駅は見つからなかった。',
      'suggestions は空配列にし、見つからなかったことを正直に伝えるか、',
      'ユーザが答えられる具体的な確認を 1 つだけ返すこと。',
      '要望に合わない駅を埋め合わせに提案してはならない。',
    ].join('\n');
  }
  const lines = picked.map((station, index) => {
    const lines_ = station.lineNames.length
      ? `（${station.lineNames.join('・')}）`
      : '';
    return `${index + 1}. ${station.name}${lines_}`;
  });
  return [
    '# 提案してよい駅（要望に合う順）',
    '',
    ...lines,
    '',
    'suggestions はこの中からこの順で入れること。ここに無い駅を入れてはならない。',
    'reply もこの駅について書くこと（ここに無い駅名を本文で挙げない）。',
    '提案が不要な応答（使い方の質問、確認質問を返す場合）では suggestions を',
    '空配列にしてよい。',
  ].join('\n');
};
