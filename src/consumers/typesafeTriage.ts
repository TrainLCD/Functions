/**
 * フィードバックのトリアージ判定を TypeSafe（System One / Jev）で行う。
 *
 * TypeSafe が返すのは Choice / Score / Noul の型付き判定だけで、文章生成は行わない
 * （<https://docs.typesafe.ai/api>）。そのためタイトルと要約は Workers AI が担当し、
 * ここではスパム・カテゴリ・優先度・原因コンポーネントの判定だけを扱う。
 *
 * 質問定義と閾値は計測スクリプト（src/cli/typesafe-triage-spike.ts）と共有する。
 * 別々に持つと、スパイクで測ったものと本番で動くものが食い違う。
 */
import type { Report } from '../models/feedback';
import type { Env } from '../types';

const API_URL = 'https://api.typesafe.ai/v1/systemone';

/** 時間を置けば通る可能性があるステータス（レート制限と過負荷） */
const RETRYABLE_STATUSES = new Set([429, 529]);
const RETRYABLE_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

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

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

// ---- 質問定義 ----

export type QuestionId = keyof typeof QUESTIONS;

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

/**
 * スパム確定には満たないが人手確認に回す下限。キーワード判定（looksLikeSpam）が
 * Jev の非スパム判定を覆してよいかの境界にも使う。
 */
export const SPAM_REVIEW_THRESHOLD = T.SPAM_REVIEW;

/**
 * 1 リクエストにまとめて投げる。TypeSafe の質問は互いに独立で並列評価されるため、
 * 一部の入力でしか使わない質問（praise 判定など）も投機的に同梱してよい。
 *
 * 命令・基準はすべて日本語で書いている。判定対象が日本語のフィードバックで、
 * 「車内放送の書き起こし」のように英語に置き換えると輪郭がぼやける概念を
 * 基準に含めるため。一致率が低い場合、次に振るべき変数は命令文の言語。
 */
export const QUESTIONS = {
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

export type Verdict = {
  isSpam: boolean;
  needsSpamReview: boolean;
  /** is_spam と is_announcement_transcript の大きい方。スパムらしさの生の信号 */
  spamSignal: number;
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

export function compose(answers: Record<string, Answer>): Verdict {
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
    spamSignal: Math.max(spamSignal, announcement),
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

/** TypeSafe に渡す状態。本文だけでなく、判定の手がかりになる文脈も名前付きで渡す */
function buildState(report: Report): Record<string, unknown> {
  return {
    feedback: report.description,
    report_type: report.reportType,
    app_version: report.appVersion,
    app_edition: report.appEdition,
    auto_mode_enabled: report.autoModeEnabled,
    os: report.deviceInfo?.osName ?? null,
    has_stacktrace: Boolean(report.stacktrace),
  };
}

/**
 * 判定を 1 リクエストで取得する。質問は互いに独立で並列に評価されるため、
 * 一部の入力でしか使わない質問も同じリクエストに含めてよい。
 */
export async function judgeFeedback(
  env: Env,
  report: Report
): Promise<Verdict> {
  const body = JSON.stringify({
    state: buildState(report),
    model: env.TYPESAFE_MODEL,
    questions: QUESTIONS,
  });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRYABLE_ATTEMPTS; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (res.ok) {
      const json = (await res.json()) as SystemOneResponse;
      return compose(json.answers);
    }
    const text = await res.text().catch(() => '');
    lastError = new Error(`TypeSafe API ${res.status}: ${text.slice(0, 300)}`);
    // 429（レート制限）と 529（過負荷）は時間を置けば通る。それ以外は再試行しても
    // 同じ結果になるため即座に諦める。<https://docs.typesafe.ai/api>
    if (!RETRYABLE_STATUSES.has(res.status)) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    // ヘッダが無いと get() は null を返し、Number(null) は 0。
    // isFinite(0) は true なので、正値であることまで確かめないと待機しない。
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_BASE_MS * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw lastError ?? new Error('TypeSafe API の呼び出しに失敗した');
}
