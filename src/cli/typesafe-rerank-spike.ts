/**
 * 提案駅のリランク（src/agent/rerank.ts）をオフラインで実測するスパイク。
 *
 * 出したい数字は 3 つ。
 *   1. 正解の駅を上位 5 件で拾えるか（recall@5）
 *   2. 無関係な駅を上位 5 件に入れないか（reject 違反）
 *   3. 「合う駅が無い」を空配列で表現できるか、そのための閾値が引けるか（分離幅）
 * あわせて案 X（候補ごとに 1 リクエスト）と案 Y（1 リクエストに集約）の
 * 精度・トークン・レイテンシを比べ、どちらを採るかを決める。
 *
 * # 2 段で動かす
 *
 * 判定の入力になる候補プールは手で書かない。実際の駅検索
 * （src/agent/tools.ts の searchStationsByName）を評価セットの検索語で叩いて作る。
 *
 *   STATION_API_GRAPHQL_URL=https://... \
 *     npm run typesafe-rerank-spike -- --record --out /tmp/rerank-pool.json
 *   TYPESAFE_API_KEY=... \
 *     npm run typesafe-rerank-spike -- --pool /tmp/rerank-pool.json
 *
 * プールはリポジトリ外（/tmp など）へ置く。生成物であり、コミットしない。
 *
 * 対話本体の LLM は通さない。ここで測るのは「プールが与えられたときの選択」なので、
 * LLM の揺れをプールに混ぜると測りたいものが見えなくなる。LLM の選択との比較は
 * 本番シャドー（Phase 2）で実トラフィック上で行う。
 *
 * # 評価セット（agent-rerank-eval.jsonl）の形
 *
 *   id          識別子
 *   request     ユーザ発話（要望そのもの）
 *   from        現在駅の駅名（任意）。検索は「そこから直通で行ける駅」に絞られる
 *   queries     候補プールを作る検索語。正解だけでなく紛らわしい語も入れる
 *   expect      上位 5 件に入るべき駅名（完全一致）。網羅的な正解集合ではない
 *   reject      上位 5 件に入ってはいけない駅名（完全一致）
 *   expectEmpty true なら、閾値で全候補が落ちるべき
 *   note        意図（人間向け。実行では使わない）
 *
 * expect / reject は手で書いた期待値である。--record で実際のプールを見て、
 * 期待が現実と食い違っていたら評価セット側を直す。プールに存在しない expect は
 * 「判定の外し」ではなく「プールに無い」として分母から除く。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  type CandidateScore,
  judgeCandidates,
  type RerankInput,
  selectSuggestions,
} from '../agent/rerank';
import type { StationSuggestion } from '../agent/schema';
import { searchStationsByName } from '../agent/tools';
import type { Env } from '../types';

const EVAL_PATH = resolve(process.cwd(), 'agent-rerank-eval.jsonl');

/** 閾値のグリッド探索の範囲 */
const THRESHOLDS = [
  0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85,
  0.9,
];

type EvalItem = {
  id: string;
  request: string;
  from?: string;
  queries: string[];
  expect?: string[];
  reject?: string[];
  expectEmpty?: boolean;
  note?: string;
};

type PoolItem = EvalItem & {
  currentStationName: string | null;
  candidates: StationSuggestion[];
};

/**
 * モデル名は wrangler.jsonc の vars から読む。ここで文字列を持つと、本体を
 * 切り替えたあと var を変えてもスパイクだけ別のモデルを測り続けることになる。
 */
function resolveModel(): string {
  const cfg = parseJsonc(
    readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8')
  ) as { vars?: Record<string, string> };
  const model = cfg.vars?.TYPESAFE_MODEL;
  if (!model) {
    throw new Error('wrangler.jsonc の vars に TYPESAFE_MODEL がありません');
  }
  return model;
}

function loadEval(limit: number): EvalItem[] {
  const items = readFileSync(EVAL_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalItem);
  return limit > 0 ? items.slice(0, limit) : items;
}

// ---- --record: 実際の駅検索でプールを作る ----

/** 現在駅の名前から groupId を解決する。見つからなければ nationwide 検索に倒す */
async function resolveFrom(
  env: Env,
  name: string | undefined
): Promise<{ groupId: number | undefined; resolved: string | null }> {
  if (!name) return { groupId: undefined, resolved: null };
  const hits = await searchStationsByName(env, name, undefined);
  const exact = hits.find((s) => s.name === name) ?? hits[0];
  if (!exact) {
    console.warn(`  現在駅「${name}」を解決できなかった。全国検索で続行する`);
    return { groupId: undefined, resolved: null };
  }
  return { groupId: exact.stationGroupId, resolved: exact.name };
}

async function record(limit: number, outPath: string | null): Promise<void> {
  const url = process.env.STATION_API_GRAPHQL_URL;
  if (!url) {
    console.error(
      'STATION_API_GRAPHQL_URL が未設定。--record は駅検索 API を直接叩くため必須。'
    );
    process.exit(1);
  }
  const env = { STATION_API_GRAPHQL_URL: url } as unknown as Env;
  const items = loadEval(limit);
  const pool: PoolItem[] = [];

  for (const item of items) {
    const { groupId, resolved } = await resolveFrom(env, item.from);
    // 同じ駅が複数の検索語で返るため stationId で重複を除く。順序は検索語の順
    const seen = new Set<number>();
    const candidates: StationSuggestion[] = [];
    for (const query of item.queries) {
      const hits = await searchStationsByName(env, query, groupId);
      for (const hit of hits) {
        if (seen.has(hit.stationId)) continue;
        seen.add(hit.stationId);
        candidates.push(hit);
      }
    }
    pool.push({ ...item, currentStationName: resolved, candidates });
    console.log(
      `${item.id.padEnd(28)} 候補 ${String(candidates.length).padStart(3)} 件` +
        (resolved ? `（現在駅 ${resolved}）` : '')
    );
    warnMissingExpectations(item, candidates);
  }

  const json = JSON.stringify(pool, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, 'utf8');
    console.log(`\nプールを ${outPath} に書き出した`);
  } else {
    console.log(json);
  }
}

/** 期待した駅がプールに入っていなければ、評価セット側の問題として先に知らせる */
function warnMissingExpectations(
  item: EvalItem,
  candidates: readonly StationSuggestion[]
): void {
  const names = new Set(candidates.map((c) => c.name));
  const missing = (item.expect ?? []).filter((n) => !names.has(n));
  if (missing.length) {
    console.warn(`  expect がプールに無い: ${missing.join('・')}`);
  }
}

// ---- --eval: 判定して採点する ----

type ItemResult = {
  item: PoolItem;
  scores: CandidateScore[];
  elapsedMs: number;
  inputTokens: number;
};

async function judgeAll(
  pool: PoolItem[],
  shape: 'isolated' | 'batched',
  apiKey: string,
  model: string
): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const item of pool) {
    const input: RerankInput = {
      request: item.request,
      currentStationName: item.currentStationName,
    };
    let inputTokens = 0;
    const startedAt = Date.now();
    const scores = await judgeCandidates(input, item.candidates, {
      apiKey,
      model,
      shape,
      onUsage: (usage) => {
        inputTokens = usage.inputTokens;
      },
    });
    const elapsedMs = Date.now() - startedAt;
    if (!scores) {
      console.warn(`${item.id}: 判定できなかった（スキップ）`);
      continue;
    }
    results.push({ item, scores, elapsedMs, inputTokens });
  }
  return results;
}

type Grade = {
  /** プールに存在する expect のうち上位 5 件で拾えた数 / 分母 */
  recall: { hit: number; total: number };
  /** 上位 5 件に入ってしまった reject の数 */
  violations: number;
  /** expectEmpty の判定が正しかったか。対象外なら null */
  emptyOk: boolean | null;
  /** min(expect の確率) − max(reject の確率)。両方あるときのみ */
  sep: number | null;
};

function grade(result: ItemResult, threshold: number): Grade {
  const { item, scores } = result;
  const picked = selectSuggestions(scores, threshold);
  const pickedNames = new Set(picked.map((s) => s.name));
  const poolNames = new Set(item.candidates.map((c) => c.name));

  const expected = (item.expect ?? []).filter((n) => poolNames.has(n));
  const rejected = (item.reject ?? []).filter((n) => poolNames.has(n));

  const fitsOf = (name: string) =>
    scores.find((s) => s.station.name === name)?.fits;
  const expectedFits = expected
    .map(fitsOf)
    .filter((v): v is number => v !== undefined);
  const rejectedFits = rejected
    .map(fitsOf)
    .filter((v): v is number => v !== undefined);

  return {
    recall: {
      hit: expected.filter((n) => pickedNames.has(n)).length,
      total: expected.length,
    },
    violations: rejected.filter((n) => pickedNames.has(n)).length,
    emptyOk: item.expectEmpty ? picked.length === 0 : null,
    sep:
      expectedFits.length && rejectedFits.length
        ? Math.min(...expectedFits) - Math.max(...rejectedFits)
        : null,
  };
}

function reportShape(shape: string, results: ItemResult[]): void {
  console.log(`\n=== ${shape} ===`);

  console.log('\n--- 閾値ごとの成績 ---');
  console.log('閾値   recall@5      reject違反   空配列の正解');
  for (const threshold of THRESHOLDS) {
    const grades = results.map((r) => grade(r, threshold));
    const hit = grades.reduce((a, g) => a + g.recall.hit, 0);
    const total = grades.reduce((a, g) => a + g.recall.total, 0);
    const violations = grades.reduce((a, g) => a + g.violations, 0);
    const emptyTargets = grades.filter((g) => g.emptyOk !== null);
    const emptyOk = emptyTargets.filter((g) => g.emptyOk).length;
    console.log(
      `${threshold.toFixed(2)}   ${String(hit).padStart(3)}/${String(total).padEnd(3)}      ` +
        `${String(violations).padStart(3)}        ${emptyOk}/${emptyTargets.length}`
    );
  }

  // 分離幅は閾値に依存しないので 1 回だけ出す。ここが 0 以下の項目は
  // 「どの閾値でも正解と不正解を分けられない」＝質問文を直すべき項目。
  console.log('\n--- 分離幅（min(expect) − max(reject)）---');
  for (const result of results) {
    const { sep } = grade(result, 0);
    if (sep === null) continue;
    const flag = sep > 0 ? '  ' : '!!';
    console.log(`${flag} ${result.item.id.padEnd(28)} ${sep.toFixed(3)}`);
  }

  console.log('\n--- 確率の内訳（上位 5 件）---');
  for (const result of results) {
    const top = [...result.scores]
      .sort((a, b) => b.fits - a.fits)
      .slice(0, 5)
      .map((s) => `${s.station.name}:${s.fits.toFixed(2)}`)
      .join('  ');
    console.log(`${result.item.id.padEnd(28)} ${top}`);
  }

  const tokens = results.reduce((a, r) => a + r.inputTokens, 0);
  const elapsed = results.reduce((a, r) => a + r.elapsedMs, 0);
  const candidates = results.reduce((a, r) => a + r.item.candidates.length, 0);
  console.log('\n--- コスト・レイテンシ ---');
  console.log(`候補 ${candidates} 件 / 入力 ${tokens} tok`);
  console.log(`概算コスト: $${((tokens * 42) / 1e9).toFixed(6)}（$42/Btok）`);
  console.log(
    `1 項目あたり平均 ${Math.round(elapsed / Math.max(1, results.length))} ms`
  );
}

// ---- 実行 ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const limit = Number(value('--limit') ?? 0);

  if (flag('--record')) {
    await record(limit, value('--out') ?? null);
    return;
  }

  const poolPath = value('--pool');
  if (!poolPath) {
    console.error(
      '--pool <path> が必要（先に --record --out <path> でプールを作る）。'
    );
    process.exit(1);
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error('TYPESAFE_API_KEY が未設定。');
    process.exit(1);
  }

  const pool = (JSON.parse(readFileSync(poolPath, 'utf8')) as PoolItem[]).slice(
    0,
    limit > 0 ? limit : undefined
  );
  const model = resolveModel();
  const shapes =
    value('--shape') === 'x'
      ? (['isolated'] as const)
      : value('--shape') === 'y'
        ? (['batched'] as const)
        : (['batched', 'isolated'] as const);

  console.log(`対象 ${pool.length} 項目 / model=${model}`);
  for (const shape of shapes) {
    const results = await judgeAll(pool, shape, apiKey, model);
    reportShape(
      shape === 'batched' ? '案 Y（1 リクエスト集約）' : '案 X（候補ごと）',
      results
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
