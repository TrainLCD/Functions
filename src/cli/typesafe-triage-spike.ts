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

/**
 * instructions と criteria は文字列のほか、構造化オブジェクト・配列も取れる
 * （<https://docs.typesafe.ai/api>）。選択肢が紛らわしいときに what / not_for /
 * examples のような欄を持つオブジェクトで書き分けられる。欄の名前は API の
 * 予約語ではなく、こちらで決めてよい。
 */
type Description = string | Record<string, unknown> | readonly unknown[];

type NoulQuestion = {
  type: 'noul';
  instructions: Description;
  criteria?: { true: Description; false: Description };
};
type ChoiceQuestion = {
  type: 'choice';
  instructions: Description;
  criteria: Record<string, Description | null>;
};
type ScoreQuestion = {
  type: 'score';
  instructions: Description;
  criteria: readonly Description[];
};
type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

type NoulAnswer = { type: 'noul'; noul: number };
type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
type ScoreAnswer = {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

// ---- 質問定義 ----

/**
 * 1 リクエストにまとめて投げる。TypeSafe の質問は互いに独立で並列評価されるため、
 * 一部の入力でしか使わない質問（praise 判定など）も投機的に同梱してよい。
 *
 * 命令・基準はすべて日本語で書いている。判定対象が日本語のフィードバックで、
 * 「車内放送の書き起こし」のように英語に置き換えると輪郭がぼやける概念を
 * 基準に含めるため。一致率が低い場合、次に振るべき変数は命令文の言語。
 */
const QUESTIONS = {
  is_spam: {
    type: 'noul',
    instructions:
      '`feedback` は、アプリの改善とは無関係な内容か（宣伝、荒らし、無関係な雑談）。',
    criteria: {
      true: 'アプリの改善に一切つながらない内容。宣伝、荒らし、無関係な雑談、および「テスト」「送信試験」「動作チェック」のように送信を試すためだけの投稿。',
      false:
        '不具合の報告、要望、質問、感謝など、アプリに向けられた内容。書き方が拙くても、内容がアプリに向いていれば該当する。',
    },
  },
  is_announcement_transcript: {
    type: 'noul',
    instructions:
      '`feedback` は、鉄道の車内放送や駅の放送をそのまま書き写したものか。',
    criteria: {
      true: '「次は」「まもなく」「この電車は〜行きです」のような放送の文言が並び、報告者自身の訴えが無いもの。',
      false:
        '放送の文言を引用していても、それが誤っている・読み上げられないといった報告者自身の訴えを伴うもの。',
    },
  },
  is_praise_only: {
    type: 'noul',
    instructions:
      '`feedback` は、感謝・称賛・応援だけで、対応すべき不具合や要望を含まないか。',
    criteria: {
      true: '感謝や称賛のみ。直すべきものも、追加してほしいものも書かれていない。',
      false: '感謝を述べつつも、不具合の報告や要望が含まれている。',
    },
  },
  is_crash_or_data_loss: {
    type: 'noul',
    instructions:
      '`feedback` は、アプリが強制終了する、または保存された設定やデータが失われることを報告しているか。',
    criteria: {
      true: 'アプリが落ちる、フリーズして操作を受け付けない、設定やデータが消えた。',
      false: '表示の誤りや動作の不満であり、強制終了やデータ喪失ではない。',
    },
  },
  mentions_station_data: {
    type: 'noul',
    instructions:
      '`feedback` は、駅・路線・列車種別そのもののデータの誤りや欠落を指しているか。',
    criteria: {
      true: '駅名・路線名・乗換情報・停車駅・列車種別のデータが、実際と違う、または存在しない。',
      false:
        'アプリの表示・操作・音声など、データではなくアプリの振る舞いについての内容。',
    },
  },
  category: {
    type: 'choice',
    instructions: '`feedback` を、最もよく当てはまる 1 つに分類せよ。',
    criteria: {
      bug: '意図どおりに動いていない。誤動作、誤表示、クラッシュ、表示崩れ。',
      feature_request: 'まだ存在しない機能を新たに作ってほしいという要望。',
      improvement:
        '既に存在する機能を、より使いやすくしてほしいという調整の要望。',
      question: '使い方の確認や情報の要求。直してほしいものは示されていない。',
      praise: '感謝・称賛・応援のみで、対応すべき要望を含まない。',
    },
  },
  component: {
    // 実測で station_api -> mobile_app の取り違えが 4 件出た（ナンバリング記号・
    // 路線カラー・ロゴ・イメージカラー）。いずれも「表示が誤っている」と読めるため、
    // 値が誤っているのか描画が誤っているのかを focus と not_for で明示する。
    type: 'choice',
    instructions: {
      question:
        '`feedback` が報告している事象の原因は、どこにあると考えられるか。',
      focus:
        '画面に出ている内容が誤っている場合、その値がデータとして誤っているのか、描画のされ方が誤っているのかで分ける。',
    },
    criteria: {
      mobile_app: {
        what: 'アプリ本体の振る舞い。描画・レイアウト・文字の見切れ・スクロール・テーマ、音声の再生制御、クラッシュ、設定項目、位置情報の追従。路線ロゴの画像そのもの。',
        not_for:
          '表示されている記号・色・名称・停車駅などの値そのものが実際と異なる場合は station_api。',
        examples: [
          '文字が見切れる、乗換案内がスクロールしないと読めない',
          '位置情報が更新されず手前の駅を表示し続ける',
          'アプリが強制終了する、オートモードが停止する',
          'アナウンス中に他アプリの音量が下がらない',
          '路線のロゴが別の事業者のロゴになっている',
        ],
      },
      station_api: {
        what: '駅・路線・列車種別のデータの値そのもの。駅名、駅ナンバリングの記号と形、路線カラー、停車駅と通過駅、乗換情報、駅名や種別名の多言語表記。',
        not_for:
          '値は正しく表示の崩れが問題である場合や、路線ロゴの画像が別の事業者のものになっている場合は mobile_app（ロゴ画像はアプリに同梱されている）。',
        examples: [
          'ナンバリングの記号が別の路線のものになっている',
          '路線のイメージカラーが実際と異なる',
          '特急の停車駅・通過駅の設定が実際と異なる',
          '駅名の英語表記・中国語表記が誤っている',
        ],
      },
      functions: {
        what: 'サーバ側の処理。読み上げ音声の合成品質やイントネーション、AI チャットの応答、フィードバックの送信、画像のアップロード。',
        not_for:
          '音が鳴らない・音量が下がらないといった端末側の再生制御は mobile_app。',
        examples: [
          '読み上げのイントネーションが不自然',
          'AI に質問するとエラーしか返らない',
        ],
      },
      website: {
        what: '公式サイト（trainlcd.app）そのもの。',
        not_for:
          'アプリ内のエラーやクラッシュはサイトとは無関係なので mobile_app。',
        examples: ['公式サイトのリンクが 404 になる'],
      },
      unknown: {
        what: 'この内容だけでは原因の所在を絞り込めない。',
        not_for:
          '内容から所在が読み取れるなら、確信が持てなくても該当する選択肢を選ぶ。',
        examples: [
          '使い方の質問',
          '感謝や称賛のみ',
          '症状が漠然としていて対象を特定できない',
        ],
      },
    },
  },
  severity: {
    type: 'score',
    instructions:
      '`feedback` が報告している事象は、利用者にとってどれだけ重いか。',
    criteria: [
      '見た目や文言の体裁の問題で、機能そのものは使える。',
      '機能は使えるが、表示される内容が誤っている、または余分な操作が必要になる。',
      '特定の機能が使えない、または誤った案内によって利用者が乗車の判断を誤りうる。',
      'アプリが強制終了する、データが失われる、または乗車中にアプリが使い物にならない。',
    ],
  },
  actionability: {
    type: 'score',
    instructions:
      '`feedback` は、開発者が調査に着手するのに十分な具体性を備えているか。',
    criteria: [
      '何が起きたのか特定できず、調査を始められない。',
      '症状は分かるが、再現の条件や対象（駅名・路線名・画面名）が不足している。',
      '対象と症状が具体的に書かれており、そのまま調査に着手できる。',
    ],
  },
} satisfies Record<string, Question>;

type QuestionId = keyof typeof QUESTIONS;

// ---- 合成ロジック（コード側の判断） ----

/**
 * 実測（46 件）でフィッティングした閾値。グリッド探索の最良値ではなく、
 * 分離幅の中央に寄せた丸めた値を使う。最良値は 46 点に対して過学習する。
 */
const T = {
  /**
   * スパム確定の閾値。実測では正当な報告のスパム信号の最大が 0.27、スパムの最小が
   * 0.75 と大きく開いたため、その中間に置いている。正当な報告を握り潰す方が
   * スパムを 1 件通すより損失が大きいという方針は現行実装から引き継ぐ。
   */
  SPAM: 0.5,
  /** スパム確定には満たないが、人手確認に回す下限 */
  SPAM_REVIEW: 0.3,
  /** urgent へのハードルール */
  CRASH: 0.7,
  /** bug の severity から triageLevel を決める境界 */
  BUG_URGENT: 2.4,
  BUG_HIGH: 1.8,
  BUG_MEDIUM: 0.5,
  /** 不具合ではない要望を medium に上げる境界 */
  REQUEST_MEDIUM: 1.0,
} as const;

type Verdict = {
  isSpam: boolean;
  needsSpamReview: boolean;
  category: string;
  categoryConfidence: number;
  component: string;
  componentConfidence: number;
  triageLevel: 'urgent' | 'high' | 'medium' | 'low';
  severity: number;
  actionability: number;
};

function noul(answers: Record<string, Answer>, id: QuestionId): number {
  const a = answers[id];
  return a?.type === 'noul' ? a.noul : Number.NaN;
}
function choice(answers: Record<string, Answer>, id: QuestionId): ChoiceAnswer {
  const a = answers[id];
  if (a?.type !== 'choice') throw new Error(`choice 回答が無い: ${id}`);
  return a;
}
function score(answers: Record<string, Answer>, id: QuestionId): ScoreAnswer {
  const a = answers[id];
  if (a?.type !== 'score') throw new Error(`score 回答が無い: ${id}`);
  return a;
}

function compose(answers: Record<string, Answer>): Verdict {
  const praise = noul(answers, 'is_praise_only');
  const spamSignal = noul(answers, 'is_spam');
  const announcement = noul(answers, 'is_announcement_transcript');

  // 車内放送の書き起こしは「ご利用ありがとうございます」を含むため is_praise_only が
  // 上がる。放送判定を praise ゲートの外に出さないと、放送がそのまま素通りする。
  //
  // 感謝ゲートは固定値と比べない。実測で、明確なスパム（is_spam 0.96）が
  // is_praise_only ちょうど 0.50 で弾かれた。守りたいのは「感謝の方がスパムらしさ
  // より強いとき」だけなので、両者の大小で判定する。
  const isSpam =
    announcement >= T.SPAM || (spamSignal >= T.SPAM && praise < spamSignal);
  const needsSpamReview =
    !isSpam &&
    praise < spamSignal &&
    Math.max(spamSignal, announcement) >= T.SPAM_REVIEW;

  const cat = choice(answers, 'category');
  const comp = choice(answers, 'component');
  const sev = score(answers, 'severity');
  const act = score(answers, 'actionability');
  const category = isSpam ? 'question' : cat.choice;

  return {
    isSpam,
    needsSpamReview,
    category,
    categoryConfidence: cat.confidence,
    component: isSpam ? 'unknown' : comp.choice,
    componentConfidence: comp.choice === 'unknown' ? 0 : comp.confidence,
    triageLevel: resolveLevel(answers, isSpam, category, sev.score),
    severity: sev.score,
    actionability: act.score,
  };
}

/**
 * triageLevel を決める。
 *
 * severity は「不具合がどれだけ重いか」の尺度なので、不具合でないものに当てても
 * 意味を持たない。実測では要望に高い severity が付いて優先度が跳ね上がっていたため、
 * カテゴリで分岐させ、bug にだけ severity の全域を使う。
 *
 * 当初は severity / breadth / actionability の加重和にしていたが、実測で breadth は
 * 正解レベルと全く相関しなかった（urgent 0.82 / high 0.81 / medium 1.07 / low 1.04）。
 * 1 通のフィードバックには影響範囲の情報がほとんど含まれていないためで、質問ごと
 * 削除した。actionability は着手順の材料として残し、優先度には入れない。
 */
function resolveLevel(
  answers: Record<string, Answer>,
  isSpam: boolean,
  category: string,
  severity: number
): Verdict['triageLevel'] {
  if (isSpam) return 'low';
  if (category === 'praise' || category === 'question') return 'low';
  // 加重和では表現できないハードルール。単独で urgent に上げる。
  if (noul(answers, 'is_crash_or_data_loss') >= T.CRASH) return 'urgent';
  if (category === 'bug') {
    if (severity >= T.BUG_URGENT) return 'urgent';
    if (severity >= T.BUG_HIGH) return 'high';
    if (severity >= T.BUG_MEDIUM) return 'medium';
    return 'low';
  }
  // feature_request / improvement は不具合ではないので medium を上限にする
  return severity >= T.REQUEST_MEDIUM ? 'medium' : 'low';
}

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

async function ask(
  apiKey: string,
  model: string,
  feedback: string
): Promise<SystemOneResponse> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // 本番では report_type / app_version / os / has_stacktrace も名前付きで渡す。
      // fewshot.jsonl には本文しか無いため、ここでは本文のみ。
      state: { feedback },
      model,
      questions: QUESTIONS,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TypeSafe API ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as SystemOneResponse;
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
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 0 : 0;
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

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
    writeFileSync(outPath, JSON.stringify(records, null, 2), 'utf8');
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
