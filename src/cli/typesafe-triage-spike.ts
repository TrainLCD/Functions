/**
 * TypeSafe（System One / Jev）でフィードバックのトリアージ判定ができるかを、
 * fewshot.jsonl の 18 件を正解ラベルとして実測するスパイク。
 *
 * 目的は「日本語のフィードバックに対して型付き判定がどれだけ一致するか」と
 * 「confidence が公開リポジトリ起票の門（PUBLIC_ISSUE_MIN_CONFIDENCE）として
 * 機能する分布になっているか」の 2 点を数字で出すこと。実装の置き換えはしない。
 *
 * 注意: fewshot.jsonl は現行 Workers AI 経路に few-shot として与えている例そのもの
 * なので、現行モデルにとっては既出であり、ここで出る一致率を現行経路の精度と
 * 直接比較してはいけない。TypeSafe にとっては未見のため、TypeSafe 側の数字だけが
 * 意味を持つ。
 *
 * TypeSafe は判定のみを返し、文章生成は行わない。したがって title / summary は
 * 対象外で、判定（isSpam / category / triageLevel / component）だけを見る。
 *
 * 例:
 *   TYPESAFE_API_KEY=... npm run typesafe-spike
 *   TYPESAFE_API_KEY=... npm run typesafe-spike -- --limit 3 --json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  compose,
  QUESTIONS,
  type SystemOneResponse,
} from '../consumers/typesafeTriage';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const FEWSHOT_PATH = resolve(process.cwd(), 'fewshot.jsonl');

/**
 * モデル名は wrangler.jsonc の vars から読む。ここで文字列を持つと、本体を
 * 切り替えたあと var を変えてもスパイクだけ別のモデルを測り続けることになる。
 */
function resolveModel(): string {
  const cfgPath = resolve(process.cwd(), 'wrangler.jsonc');
  const cfg = parseJsonc(readFileSync(cfgPath, 'utf8')) as {
    vars?: Record<string, string>;
  };
  const model = cfg.vars?.TYPESAFE_MODEL;
  if (!model) {
    throw new Error('wrangler.jsonc の vars に TYPESAFE_MODEL がありません');
  }
  return model;
}

// ---- TypeSafe API の型（docs.typesafe.ai/api） ----

// ---- 実行 ----

type GoldenItem = {
  input: string;
  golden: {
    isSpam: boolean;
    category: string;
    triageLevel: string;
    /** loadGolden が null を 'unknown' に正規化するため常に string */
    component: string;
  };
};

function loadGolden(limit: number): GoldenItem[] {
  const lines = readFileSync(FEWSHOT_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  const items: GoldenItem[] = [];
  for (const line of lines) {
    const o = JSON.parse(line);
    if (!o?.input || !o?.output || o.disabled) continue;
    const out = JSON.parse(o.output);
    items.push({
      input: String(o.input),
      golden: {
        isSpam: Boolean(out.isSpam),
        category: String(out.category),
        triageLevel: String(out.triageLevel),
        component: out.component == null ? 'unknown' : String(out.component),
      },
    });
  }
  return limit > 0 ? items.slice(0, limit) : items;
}

/** 時間を置けば通る可能性があるステータス（レート制限と過負荷） */
const RETRYABLE_STATUSES = new Set([429, 529]);

async function ask(
  apiKey: string,
  model: string,
  feedback: string
): Promise<SystemOneResponse> {
  const body = JSON.stringify({
    // 本番では report_type / app_version / os / has_stacktrace も名前付きで渡す。
    // fewshot.jsonl には本文しか無いため、ここでは本文のみ。
    state: { feedback },
    model,
    questions: QUESTIONS,
  });
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (res.ok) return (await res.json()) as SystemOneResponse;
    const text = await res.text().catch(() => '');
    lastError = new Error(`TypeSafe API ${res.status}: ${text.slice(0, 500)}`);
    // 逐次実行なので、後半で落ちるとそこまでの計測が無駄になる。
    // 429 と 529 は時間を置けば通る。<https://docs.typesafe.ai/api>
    if (!RETRYABLE_STATUSES.has(res.status)) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : 500 * 2 ** attempt;
    console.warn(`  ${res.status} のため ${waitMs}ms 待って再試行する`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw lastError ?? new Error('TypeSafe API の呼び出しに失敗した');
}

function pad(s: string, n: number): string {
  // 日本語は 2 幅として揃える
  const w = [...s].reduce(
    (a, c) => a + ((c.codePointAt(0) ?? 0) < 0x80 ? 1 : 2),
    0
  );
  return s + ' '.repeat(Math.max(0, n - w));
}

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error(
      'TYPESAFE_API_KEY が未設定。TYPESAFE_API_KEY=... npm run typesafe-spike のように渡すこと。'
    );
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dumpJson = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const rawLimit = limitIdx >= 0 ? args[limitIdx + 1] : undefined;
  const limit = rawLimit === undefined ? 0 : Number(rawLimit);
  if (limitIdx >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
    // Number('foo') も Number(undefined) も 0 になり、loadGolden(0) は全件を返す。
    // 件数を絞ったつもりで全件分の API を呼ぶことになるため、ここで落とす。
    console.error('--limit には正の整数を指定すること');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (outIdx >= 0 && (!outPath || outPath.startsWith('--'))) {
    // 値が無いと --out が黙って無視され、`--out --json` は `--json` という名前の
    // ファイルを作ってしまう。API を呼ぶ前に落とす。
    console.error('--out には書き出し先のパスを指定すること');
    process.exit(1);
  }

  const model = resolveModel();
  const items = loadGolden(limit);
  console.log(`対象 ${items.length} 件 / model=${model}\n`);

  let okSpam = 0;
  let okCat = 0;
  let okLevel = 0;
  let okComp = 0;
  let inTok = 0;
  let outTok = 0;
  let elapsed = 0;
  const compConfidences: number[] = [];
  const rows: string[] = [];
  /** 閾値のフィッティングを API 再実行なしで行うための生データ */
  const records: unknown[] = [];
  const misses: { field: string; input: string; got: string; want: string }[] =
    [];

  for (const [i, item] of items.entries()) {
    const started = Date.now();
    const res = await ask(apiKey, model, item.input);
    elapsed += Date.now() - started;
    inTok += res.usage.input_tokens;
    outTok += res.usage.output_tokens;

    const v = compose(res.answers);
    const g = item.golden;
    const mSpam = v.isSpam === g.isSpam;
    const mCat = v.category === g.category;
    const mLevel = v.triageLevel === g.triageLevel;
    const mComp = v.component === g.component;
    if (mSpam) okSpam++;
    if (mCat) okCat++;
    if (mLevel) okLevel++;
    if (mComp) okComp++;
    if (!v.isSpam) compConfidences.push(v.componentConfidence);

    records.push({
      input: item.input,
      golden: g,
      answers: res.answers,
      verdict: v,
    });
    // 1 件ごとに書き出す。逐次実行なので、後半で失敗したときに
    // それまでの計測（API を叩いて得た高価なデータ）を失わないようにする。
    if (outPath)
      writeFileSync(outPath, JSON.stringify(records, null, 2), 'utf8');
    const head = item.input.slice(0, 40).replace(/\n/g, ' ');
    if (!mSpam) {
      misses.push({
        field: 'isSpam',
        input: head,
        got: String(v.isSpam),
        want: String(g.isSpam),
      });
    }
    if (!mCat) {
      misses.push({
        field: 'category',
        input: head,
        got: v.category,
        want: g.category,
      });
    }
    if (!mLevel) {
      misses.push({
        field: 'triageLevel',
        input: head,
        got: v.triageLevel,
        want: g.triageLevel,
      });
    }
    if (!mComp) {
      misses.push({
        field: 'component',
        input: head,
        got: v.component,
        want: g.component,
      });
    }

    const mark = (ok: boolean) => (ok ? ' ' : '×');
    rows.push(
      [
        String(i + 1).padStart(2),
        pad(`${item.input.slice(0, 22)}…`, 26),
        `${mark(mSpam)}spam=${v.isSpam ? 'T' : 'F'}/${g.isSpam ? 'T' : 'F'}`,
        `${mark(mCat)}${pad(`${v.category}/${g.category}`, 30)}`,
        `${mark(mLevel)}${pad(`${v.triageLevel}/${g.triageLevel}`, 16)}`,
        `${mark(mComp)}${pad(`${v.component}/${g.component}`, 26)}`,
        `conf=${v.componentConfidence.toFixed(2)}`,
        `sev=${v.severity.toFixed(2)} act=${v.actionability.toFixed(2)}`,
        v.needsSpamReview ? 'REVIEW' : '',
      ].join(' ')
    );
    console.log(rows[rows.length - 1]);

    if (dumpJson) {
      console.log(
        JSON.stringify(
          { input: item.input, answers: res.answers, verdict: v },
          null,
          2
        )
      );
    }
  }

  const n = items.length;
  const pct = (k: number) => `${((k / n) * 100).toFixed(1)}% (${k}/${n})`;
  console.log('\n--- 一致率（正解 = fewshot.jsonl の手当てラベル） ---');
  console.log(`isSpam       : ${pct(okSpam)}`);
  console.log(`category     : ${pct(okCat)}`);
  console.log(`triageLevel  : ${pct(okLevel)}  ※暫定閾値での結果`);
  console.log(`component    : ${pct(okComp)}`);

  const sorted = [...compConfidences].sort((a, b) => a - b);
  const q = (p: number) =>
    sorted.length
      ? sorted[Math.floor((sorted.length - 1) * p)].toFixed(2)
      : '-';
  const over = compConfidences.filter((c) => c >= 0.7).length;
  console.log('\n--- component の confidence 分布（非スパムのみ） ---');
  console.log(
    `min=${q(0)} p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} max=${q(1)}`
  );
  console.log(
    `PUBLIC_ISSUE_MIN_CONFIDENCE(0.7) 以上: ${over}/${compConfidences.length} 件`
  );

  console.log('\n--- 不一致の内訳 ---');
  for (const f of ['isSpam', 'category', 'triageLevel', 'component']) {
    const rows = misses.filter((m) => m.field === f);
    if (rows.length === 0) continue;
    console.log(`\n[${f}] ${rows.length} 件`);
    const pairs = new Map<string, number>();
    for (const m of rows) {
      const k = `${m.want} → ${m.got}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
      console.log(`  正解=${m.want} 判定=${m.got}  ${m.input}…`);
    }
    console.log(
      `  混同: ${[...pairs.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `${k}(${c})`)
        .join(', ')}`
    );
  }

  if (outPath) {
    console.log(`\n生データを ${outPath} に書き出した（閾値の再計算に使う）`);
  }

  console.log('\n--- コスト・レイテンシ ---');
  console.log(`入力 ${inTok} tok / 出力 ${outTok} tok（出力は無課金）`);
  console.log(`概算コスト: $${((inTok * 42) / 1e9).toFixed(6)}（$42/Btok）`);
  console.log(`1 件あたり平均 ${Math.round(elapsed / n)} ms（逐次実行）`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
