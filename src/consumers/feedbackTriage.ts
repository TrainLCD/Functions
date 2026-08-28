/**
 * feedback-triage キュー consumer — Workers AI でトリアージし、GitHub Issue 作成と
 * Discord 通知を行う。AI 呼び出し以外のロジックは旧 Cloud Functions から流用。
 */
import dayjs from 'dayjs';
import type {
  AICategory,
  AIComponent,
  AIReport,
  AITriageLevel,
  FewShotItem,
} from '../models/ai';
import type { DiscordEmbed } from '../models/common';
import type { Report } from '../models/feedback';
import type { Env, FeedbackQueueMessage } from '../types';

/** フィードバック原本を保管する非公開リポジトリ */
const INTERNAL_REPO = 'TrainLCD/Issues';

/**
 * 原因コンポーネント → 起票先の公開リポジトリ。
 * 公開リポジトリなのでフィードバックの内容は一切載せず、非公開の管理チケットへの
 * 参照（Issue 番号・チケットID）だけを持つスタブ Issue を立てる。
 */
const COMPONENT_REPOS: Record<AIComponent, string> = {
  mobile_app: 'TrainLCD/MobileApp',
  station_api: 'TrainLCD/StationAPI',
  functions: 'TrainLCD/Functions',
  website: 'TrainLCD/Website',
};

/** 原因コンポーネントを信用して公開リポジトリに起票する最低信頼度 */
export const PUBLIC_ISSUE_MIN_CONFIDENCE = 0.7;

/** 公開リポジトリへ転記する対象カテゴリ（質問は原因特定の対象外） */
const PUBLIC_ISSUE_CATEGORIES: readonly AICategory[] = [
  'bug',
  'improvement',
  'feature_request',
];

const GITHUB_LABELS = {
  PLATFORM_IOS: '🍎 iOS',
  PLATFORM_IPADOS: '🍎 iPadOS',
  PLATFORM_APPCLIP: '📎 App Clip',
  PLATFORM_ANDROID: '🤖 Android',
  PLATFORM_OTHER_OS: '❓ Other OS',
  PRODUCTION_APP: '🌏 Production',
  CANARY_APP: '🐥 Canary',
  FEEDBACK_TYPE: '🙏 Feedback',
  CRASH_TYPE: '💣 Crash',
  SPAM_TYPE: '💩 Spam',
  UNKNOWN_TYPE: '❓ Unknown Type',
  AUTOMODE_ENABLED: '🤖 Auto Mode',
  CATEGORY_BUG: '🐛 Bug',
  CATEGORY_FEATURE_REQUEST: '✨ Feature Request',
  CATEGORY_IMPROVEMENT: '🛠️ Improvement',
  CATEGORY_QUESTION: '❓ Question',
  CATEGORY_PRAISE: '💚 Praise',
  TRIAGE_URGENT: '🔴 P0 / Urgent',
  TRIAGE_HIGH: '🟠 P1 / High',
  TRIAGE_MEDIUM: '🟡 P2 / Medium',
  TRIAGE_LOW: '🟢 P3 / Low',
} as const;

const CATEGORY_LABELS: Record<AICategory, string> = {
  bug: GITHUB_LABELS.CATEGORY_BUG,
  feature_request: GITHUB_LABELS.CATEGORY_FEATURE_REQUEST,
  improvement: GITHUB_LABELS.CATEGORY_IMPROVEMENT,
  question: GITHUB_LABELS.CATEGORY_QUESTION,
  praise: GITHUB_LABELS.CATEGORY_PRAISE,
};

const TRIAGE_LABELS: Record<AITriageLevel, string> = {
  urgent: GITHUB_LABELS.TRIAGE_URGENT,
  high: GITHUB_LABELS.TRIAGE_HIGH,
  medium: GITHUB_LABELS.TRIAGE_MEDIUM,
  low: GITHUB_LABELS.TRIAGE_LOW,
};

const CATEGORY_SYNONYMS: Record<string, AICategory> = {
  bug: 'bug',
  defect: 'bug',
  crash: 'bug',
  feature: 'feature_request',
  feature_request: 'feature_request',
  featurerequest: 'feature_request',
  request: 'feature_request',
  improvement: 'improvement',
  enhancement: 'improvement',
  improve: 'improvement',
  question: 'question',
  support: 'question',
  help: 'question',
  praise: 'praise',
  thanks: 'praise',
  thankyou: 'praise',
  gratitude: 'praise',
  compliment: 'praise',
  kudos: 'praise',
  positive: 'praise',
};

// モデルは enum 外の表記（"MobileApp" / "ios" / "web" など）を返すことがあるため、
// 区切り文字を除去したキーで正規化する。未知の値は null（＝原因未特定）に落とす。
const COMPONENT_SYNONYMS: Record<string, AIComponent> = {
  mobileapp: 'mobile_app',
  mobile: 'mobile_app',
  app: 'mobile_app',
  client: 'mobile_app',
  ios: 'mobile_app',
  android: 'mobile_app',
  stationapi: 'station_api',
  station: 'station_api',
  stationdata: 'station_api',
  functions: 'functions',
  function: 'functions',
  worker: 'functions',
  workers: 'functions',
  website: 'website',
  web: 'website',
  site: 'website',
  homepage: 'website',
};

const TRIAGE_SYNONYMS: Record<string, AITriageLevel> = {
  urgent: 'urgent',
  critical: 'urgent',
  p0: 'urgent',
  high: 'high',
  p1: 'high',
  medium: 'medium',
  normal: 'medium',
  p2: 'medium',
  low: 'low',
  minor: 'low',
  p3: 'low',
};

/**
 * 不具合・要望の報告で使われる語彙。これが出たら車内放送の書き起こしではないと
 * 断定してよいので、スコアリングに入る前に非スパムとして返す。
 * 「〜が違います」「反映されない」「〜してほしい」のように、報告者が「不具合」「要望」と
 * いう語を使わずに書くケースを取りこぼさないことを重視している。
 */
const ACTIONABLE =
  /(修正|改善|追加|希望|要望|不具合|バグ|誤|間違|違い|違う|反映|表示|保存|再生|遅|遅延|できない|出来ない|できません|出来ません|されない|されません|しない|しません|エラー|落ちる|クラッシュ|重複|ズレ|ずれ|おかしい|ほしい|欲しい|直し|なおし|音がない|読み上げない)/;

/**
 * 車内放送でも報告文でも使われる言い回し。単独では判断できないため早期リターンには
 * 使わず、スパムスコアの減点に留める（正当な報告を握りつぶす方が、スパムを 1 件
 * 通すより損失が大きいという方針）。
 */
const WEAK_ACTIONABLE = /(になります|になっています|になってます|されています)/;

/** 車内放送の定型句。書き起こし判定の主シグナル */
const ANNOUNCEMENT_PHRASE =
  /(次は|まもなく|この(列車|電車)は|行きです|ご利用ありがとうございます|お出口は(左|右)側です|各駅に(停ま|止ま)ります|お乗り換え)/;

export function looksLikeSpam(text: string): boolean {
  if (!text) return false;
  const t = String(text).replace(/\s+/g, ' ').trim();

  if (ACTIONABLE.test(t)) return false;

  let score = 0;

  const hasAnnouncementPhrase = ANNOUNCEMENT_PHRASE.test(t);
  if (hasAnnouncementPhrase) {
    score += 1;
  }
  // 「停車駅」「方面」「駅名・路線名の併記」はいずれも本アプリのドメイン語彙そのもので、
  // データ不備の報告に普通に現れる。放送の定型句と共起したときだけ書き起こしの
  // シグナルとして扱う（単独加点だと、正確な報告ほどスパム判定されてしまう）。
  if (hasAnnouncementPhrase && /(停車駅|方面)/.test(t)) score += 1;
  if (
    hasAnnouncementPhrase &&
    /([一-龥ァ-ヶー]{2,})(、|,|・|\s)([一-龥ァ-ヶー]{2,})/.test(t) &&
    /(停車|次は|方面)/.test(t)
  ) {
    score += 1;
  }
  if (
    /(Next stop|This (train|service) (is|goes) to|Please change at)/i.test(t)
  ) {
    score += 1;
  }
  if (
    t.length >= 40 &&
    !/[。．.!?！？]/.test(t) &&
    /(次は|まもなく|行きです)/.test(t)
  ) {
    score += 0.5;
  }
  if (/[🚃🚇🚈♪🎵]/u.test(t)) {
    score += 0.5;
  }
  if (WEAK_ACTIONABLE.test(t)) score -= 1;
  return score >= 2;
}

/** モデルがタイトルを返さなかったときの穴埋め文言 */
export const MISSING_TITLE = '要約未取得';

/**
 * 日本語として成立しない生成タイトルのパターン。
 * 小型モデルは日本語生成が破綻することがあり、破損タイトルのまま起票すると
 * Issue 一覧から内容を判別できなくなる（= バックログの一次スクリーニングが機能しない）。
 * 誤検知するとまともなタイトルまで「要約失敗」に落としてしまうため、
 * 正常な日本語では起こり得ないものだけを列挙する。
 */
const BROKEN_TITLE_PATTERNS: readonly {
  name: string;
  test: (title: string) => boolean;
}[] = [
  // 文字化け（U+FFFD）・制御文字
  { name: 'replacement_char', test: (t) => /\uFFFD/.test(t) },
  {
    name: 'control_char',
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の混入そのものを検知する
    test: (t) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t),
  },
  // 日本語アプリのタイトルに現れない文字体系（ギリシャ・キリル・ヘブライ・アラビア・
  // デーヴァナーガリー・タイ・ハングル）
  {
    name: 'foreign_script',
    test: (t) =>
      /[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\uAC00-\uD7AF]/.test(
        t
      ),
  },
  // UTF-8 を Shift_JIS として解釈したときに出る典型的な文字化け漢字。現代日本語では
  // ほぼ使われない字なので、連続していなくても 2 文字あれば破損とみなす
  {
    name: 'mojibake_kanji',
    test: (t) =>
      (t.match(/[縺繧繝蜿蛻髢讌荳陦莠譌蟄蜀隱蠢遘蜷ｺｻ]/g) ?? []).length >= 2,
  },
  // 同一文字の 4 連続・同一語の 3 連続（生成ループ）
  { name: 'char_repeat', test: (t) => /(.)\1{3,}/u.test(t) },
  { name: 'phrase_repeat', test: (t) => /(.{2,4})\1{2,}/u.test(t) },
  // 同一助詞の 3 連続。「のでは」「のにも」「ものには」のように異なる助詞が連なるのは
  // 正常な日本語なので対象にしない（誤検知するとトリアージ結果ごと捨ててしまう）
  { name: 'particle_run', test: (t) => /([はがのにをでとへも])\1{2,}/.test(t) },
];

/**
 * 生成タイトルが起票に使えない（未取得 or 日本語として破損している）かを判定する。
 * true のときは破損タイトルのまま起票せず、失敗を明示したレポートに倒す。
 */
export function findBrokenTitleReason(title: string): string | null {
  const t = String(title ?? '').trim();
  if (!t) return 'empty';
  if (t === MISSING_TITLE) return 'missing';
  // 記号・空白だけのタイトル
  if (!/[\p{L}\p{N}]/u.test(t)) return 'no_word_char';
  for (const { name, test } of BROKEN_TITLE_PATTERNS) {
    if (test(t)) return name;
  }
  return null;
}

/** findBrokenTitleReason の真偽値版 */
export function isUnusableTitle(title: string): boolean {
  return findBrokenTitleReason(title) !== null;
}

export function coerceReport(raw: unknown, titleMax = 72): AIReport {
  const norm = (k: string) =>
    String(k).toLowerCase().replace(/\s+/g, '').trim();
  const map = new Map<string, unknown>();
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  for (const [k, v] of entries) map.set(norm(k), v);

  const getStr = (k: string, d = '') => String(map.get(k) ?? d).trim();
  /**
   * 0..1 の信頼度を読む。数値（または数値だけの文字列）以外と範囲外は、
   * スキーマに従っていない応答なので値を信用せず既定値に倒す。
   * Number() 任せにすると true や [1] が 1 に化けてしまうため型で絞る。
   * 特に componentConfidence は公開リポジトリへの起票判定に使うため、
   * 壊れた値をそのまま通すと内容を公開すべきでないものが流出しうる。
   */
  const getRatio = (k: string, d: number) => {
    const raw = map.get(k);
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : Number.NaN;
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d;
  };
  const getBool = (...keys: string[]) =>
    keys.some((k) => {
      const v = map.get(k);
      return v === true || v === 'true';
    });

  let title = getStr('title');
  let summary = getStr('summary');
  const isSpam = getBool('isspam');
  const rawLabels = map.get('labels');
  const labels: string[] = Array.isArray(rawLabels)
    ? rawLabels.filter((l): l is string => typeof l === 'string')
    : [];
  const confidence = getRatio('confidence', 0.5);
  const reason = getStr('reason');
  const categoryKey = getStr('category')
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '');
  const category: AICategory = CATEGORY_SYNONYMS[categoryKey] ?? 'question';
  const triageKey = getStr('triagelevel')
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '');
  const triageLevel: AITriageLevel = TRIAGE_SYNONYMS[triageKey] ?? 'medium';
  const componentKey = getStr('component')
    .toLowerCase()
    .replaceAll(/[\s_-]+/g, '');
  const component: AIComponent | null =
    COMPONENT_SYNONYMS[componentKey] ?? null;
  // 原因が特定できていないのに信頼度だけ高い、という応答を弾くため component とセットで扱う
  const componentConfidence = component
    ? getRatio('componentconfidence', 0)
    : 0;

  if (!title) title = MISSING_TITLE;
  if (title.length > titleMax) title = `${title.slice(0, titleMax - 1)}…`;
  // 要約が空だと Issue 本文の節が空になり、Discord embed も value 空でリジェクトされるため
  // 常に何らかのテキストを入れる。ただしタイトルが未取得・破損しているときにそれを
  // 要約へ伝播させると、タイトルと要約の両方が同時に壊れて内容が判別できなくなるため、
  // その場合は失敗を明示する文言に倒す。
  if (!summary) {
    summary = isUnusableTitle(title) ? TRIAGE_FAILED_SUMMARY : title;
  }

  return {
    title,
    summary,
    isSpam,
    labels,
    confidence,
    reason,
    category,
    triageLevel,
    component,
    componentConfidence,
  };
}

/**
 * モデル応答から最初のバランスした JSON オブジェクトだけを取り出してパースする。
 * 小型モデルは few-shot を真似て複数オブジェクトを続けて吐いたり、コードフェンスや
 * 末尾カンマを混ぜることがある。貪欲マッチ（最初の { 〜 最後の }）だとそれらを丸ごと
 * 掴んで全体が壊れるため、文字列・エスケープを考慮して最初の 1 個だけを抽出する。
 * 取り出せない／パースできない場合は null を返す（呼び出し側で生成失敗として扱う）。
 */
export function extractReportJson(text: string): unknown | null {
  if (!text) return null;
  // ```json ... ``` のコードフェンスを除去
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  // 閉じ括弧が見つからない＝出力途中で切れている可能性。候補は得られないので失敗扱い。
  if (end === -1) return null;

  const candidate = stripped.slice(start, end + 1);
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const parsed =
    tryParse(candidate) ??
    // 末尾カンマ（ }, や ], の直前）など軽微な崩れを 1 度だけ修復して再挑戦
    tryParse(candidate.replace(/,(\s*[}\]])/g, '$1'));
  return parsed === undefined ? null : parsed;
}

/** 自動要約欄に出す、失敗を明示する文言（空欄や偽の要約は出さない）。 */
export const TRIAGE_FAILED_SUMMARY =
  '⚠️ 自動要約に失敗しました。上記の本文（原文）をご確認ください。';

/**
 * トリアージ生成が最後まで失敗したときの、原文を捨てないためのレポート。
 * 要約は失敗を明示し、誤ったカテゴリ/トリアージは付けない（スパム扱いにもしない）。
 * タイトルには原文の冒頭を残し、Issue 一覧から内容を判別できるようにする。
 */
export function buildFailedReport(
  description: string,
  titleMax = 72
): AIReport {
  const snippet = String(description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  const title = `要約失敗: ${snippet || '（本文なし）'}`.slice(0, titleMax);
  return {
    title,
    summary: TRIAGE_FAILED_SUMMARY,
    isSpam: false,
    labels: [],
    confidence: 0,
    reason: 'triage_failed',
    category: 'question',
    triageLevel: 'medium',
    component: null,
    componentConfidence: 0,
  };
}

/**
 * ヒューリスティックがモデルの非スパム判定を覆せる、モデル側 confidence の上限。
 * これ以上の確信度でモデルが「スパムではない」と言っているときは、ヒューリスティックは
 * 上書きせず人手確認のマーカーだけを付ける。
 */
export const SPAM_OVERRIDE_MAX_CONFIDENCE = 0.5;

/** スパム上書き時に使う、内容を判別できないことを示すタイトル */
export const NON_ACTIONABLE_TITLE = '内容未分類（改善要望なし）';

/**
 * looksLikeSpam の結果をレポートに反映する。
 *
 * ヒューリスティックは補助でしかなく、正当な報告を握りつぶすと利用者の声が
 * 完全に失われる（ラベルもカテゴリも消えて候補プールから脱落する）。そのため
 * モデルが確信を持って「スパムではない」と判定しているときは分類をそのまま残し、
 * 人手確認用のマーカー（needsSpamReview）だけを立てる。
 */
export function applySpamHeuristic(
  aiReport: AIReport,
  description: string,
  opts: { triageFailed: boolean }
): { report: AIReport; needsSpamReview: boolean } {
  // トリアージ自体が失敗しているレポートは、そもそもモデルの判定が無い。
  // ここでスパムに倒すと「要約失敗」の事実が消えるため触らない。
  if (opts.triageFailed) return { report: aiReport, needsSpamReview: false };
  if (aiReport.isSpam) return { report: aiReport, needsSpamReview: false };
  if (!looksLikeSpam(description)) {
    return { report: aiReport, needsSpamReview: false };
  }
  if (aiReport.confidence >= SPAM_OVERRIDE_MAX_CONFIDENCE) {
    return { report: aiReport, needsSpamReview: true };
  }
  return {
    report: {
      ...aiReport,
      title: NON_ACTIONABLE_TITLE,
      isSpam: true,
      labels: [],
      reason: 'non-actionable',
    },
    needsSpamReview: false,
  };
}

const SYSTEM_PROMPT = `
You are a precise issue triager for TrainLCD.
Task:
1. Summarize the user's message into a ONE-LINE issue title in Japanese (≤72 chars).
2. Also create a 1–3 sentence summary in Japanese that concisely describes the feedback content.
3. Classify spam.
4. If NOT spam, pick ONE primary "category" from ["bug","feature_request","improvement","question","praise"]:
   - bug: 不具合・誤動作・クラッシュ・表示崩れ
   - feature_request: まだ存在しない機能の新規要望
   - improvement: 既存機能の改善・調整
   - question: 質問・使い方の確認・情報要求
   - praise: 感謝・称賛・応援のみで、対応すべき要望を含まないもの
5. If NOT spam, pick ONE "triageLevel" from ["urgent","high","medium","low"]:
   - urgent: クラッシュ・データ消失・広範な実用不能
   - high: 特定機能が使えない／重要機能要望
   - medium: 通常の改善・軽微なバグ
   - low: 体裁の問題・質問・軽い要望・感謝や称賛
   If spam, still output "category": "question" and "triageLevel": "low" (they are ignored for spam).
6. If NOT spam, decide WHICH component the root cause most likely lives in, as "component":
   - "mobile_app": TrainLCD の iOS/Android アプリ本体（画面表示・UI・音声再生・クラッシュ・設定・位置情報の挙動）
   - "station_api": 駅・路線・種別のデータや検索結果（駅名の誤り・駅の欠落・路線データの誤り）
   - "functions": バックエンド Workers（AIチャット・音声合成・フィードバック送信・画像アップロード・API エラー）
   - "website": 公式サイト（trainlcd.app）
   Use "unknown" when the message does not clearly point at one component.
   Also output "componentConfidence" (0..1) for how sure you are about "component".
   Use a value below 0.7 unless the message clearly identifies the responsible component.
   If spam, output "component": "unknown". Always output "componentConfidence" (0 when "unknown").

Rules:
- Newspaper-style headline: [症状/論点]+[対象]（助詞は最小限）
- No device/OS/version/URL/stack unless essential
- Prefer Japanese if input has Japanese
- Mark spam ONLY for content unrelated to improving the app: 車内放送の書き起こし、無関係な雑談、宣伝・荒らし
- NEVER mark gratitude, praise or encouragement as spam. Even with nothing to fix, it is a real message from a real user: set isSpam=false and category="praise"
- If not spam, pick labels from:
  ["bug","improvement","feature","localization","location","ui","performance","network","settings"]

Output JSON only:
{"title": "...", "summary": "...", "isSpam": true|false, "labels": [], "category": "...", "triageLevel": "...", "component": "...", "componentConfidence": 0..1, "confidence": 0..1, "reason": "..."}

Return ONLY that JSON. No prose, no markdown.
`.trim();

// Workers AI の JSON Mode（response_format）に渡すスキーマ。
// summary を required にして「フィールド欠落で要約が空」になるのを構造的に防ぐ。
// スパム時も含めて全フィールドを必須にし、フィールド欠落による既定値落ちを防ぐ
// （スパム判定時の category / triageLevel は起票側で無視する）。
const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    isSpam: { type: 'boolean' },
    labels: { type: 'array', items: { type: 'string' } },
    category: {
      type: 'string',
      enum: ['bug', 'feature_request', 'improvement', 'question', 'praise'],
    },
    triageLevel: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
    component: {
      type: 'string',
      enum: ['mobile_app', 'station_api', 'functions', 'website', 'unknown'],
    },
    componentConfidence: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  // category / triageLevel を optional にしていたため、モデルが省略した非スパムの
  // レポートが軒並み既定値（question / medium）に落ちていた。常に出力させる。
  required: [
    'title',
    'summary',
    'isSpam',
    'labels',
    'category',
    'triageLevel',
    'component',
    'componentConfidence',
    'confidence',
    'reason',
  ],
} as const;

// ---- Few-shot loader（CONFIG_KV） ----
const FEW_SHOT_TTL_MS = 10 * 60 * 1000;
let fewShotCache: { text: string; loadedAt: number } | null = null;

async function loadFewShot(env: Env): Promise<string | null> {
  const raw = await env.CONFIG_KV.get(env.FEW_SHOT_KV_KEY, 'text');
  if (!raw) return null;
  const limit = Number(env.FEW_SHOT_LIMIT) || 12;
  const perExMax = Number(env.FEW_SHOT_PER_EX_MAX) || 800;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const items: FewShotItem[] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o?.input && o?.output && !o.disabled) items.push(o as FewShotItem);
    } catch {
      // 非 JSON 行は無視
    }
  }
  const shuffled = items
    .map((it) => ({
      it,
      r: Math.random() / (it.weight && it.weight > 0 ? it.weight : 1),
    }))
    .sort((a, b) => a.r - b.r)
    .slice(0, limit)
    .map(({ it }) => it);

  const blocks = shuffled.map((it) => {
    const block = `Input:\n${String(it.input)}\nOutput:\n${String(it.output)}`;
    return block.length > perExMax ? `${block.slice(0, perExMax - 1)}…` : block;
  });
  return blocks.join('\n\n');
}

async function getFewShotText(env: Env): Promise<string> {
  const now = Date.now();
  if (fewShotCache && now - fewShotCache.loadedAt < FEW_SHOT_TTL_MS) {
    return fewShotCache.text;
  }
  const text = await loadFewShot(env);
  if (!text) {
    // フェイルハード：few-shot 未設定での誤学習や漏洩を防ぐ
    throw new Error('FEW_SHOT_NOT_AVAILABLE');
  }
  fewShotCache = { text, loadedAt: now };
  return text;
}

// JSON Mode 利用時、Workers AI は response をパース済みオブジェクトで返すことがある
// （非対応・複雑すぎでエラーのときは文字列になることもある）。両方を受けられるよう unknown で返す。
async function runTriage(
  env: Env,
  fewshot: string,
  userText: string,
  strict = false
): Promise<unknown> {
  // strict: 1 回パースに失敗した後の再試行。few-shot の模倣で複数オブジェクトを
  // 吐く／途中で切れるのを抑えるため、出力を 1 個の JSON に厳しく制約し直す。
  const strictNudge = strict
    ? '\n\nIMPORTANT: Output exactly ONE minified JSON object and nothing else. Do not repeat the examples. Do not add prose, comments, or code fences.'
    : '';
  const prompt = `${fewshot}\n\nNow process this message:\n\n<<FEEDBACK>>\n${userText}`;
  const result = await env.AI.run(env.AI_TRIAGE_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + strictNudge },
      { role: 'user', content: prompt },
    ],
    // 推論トレースを出すモデル（gemma-4 など）は本文の前に思考を吐くため、
    // 768 だと JSON が途中で切れる（finish_reason: "length"）。実測で完了まで
    // 900〜1100 トークン使うので余裕を持たせる。
    max_tokens: 2048,
    temperature: strict ? 0 : 0.2,
    // JSON Schema を強制し、summary などのフィールド欠落を防ぐ。
    response_format: { type: 'json_schema', json_schema: TRIAGE_JSON_SCHEMA },
  });
  return pickModelResponse(result);
}

/**
 * Workers AI の応答から本文を取り出す。モデルによって形が 2 通りある。
 * - `response`: 従来の Workers AI 形式（パース済みオブジェクト or 文字列）
 * - `choices[0].message.content`: OpenAI 互換形式（gemma-4 などはこちらのみ）
 * 片方しか見ないとモデル差し替え時に全件トリアージ失敗になるため、両方を受ける。
 */
export function pickModelResponse(result: unknown): unknown | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  if (r.response !== undefined && r.response !== null) return r.response;
  const content = r.choices?.[0]?.message?.content;
  return content ?? null;
}

/** runTriage の戻り（オブジェクト or 文字列）からトリアージ JSON を取り出す。 */
function normalizeTriageResponse(resp: unknown): unknown | null {
  if (resp && typeof resp === 'object') return resp;
  if (typeof resp === 'string') return extractReportJson(resp);
  return null;
}

/**
 * ログ用に応答の長さだけを返す。モデルが入力（report.description）や few-shot を
 * そのまま echo した場合でも、ユーザー投稿本文を Workers ログに残さないため。
 */
function responseLength(resp: unknown): number {
  const s = typeof resp === 'string' ? resp : JSON.stringify(resp ?? null);
  return s.length;
}

// ---- GitHub Issue 作成 ----

/** GitHub REST API への POST（Issue 作成・コメント投稿の共通処理）。 */
function githubPost(env: Env, path: string, body: unknown): Promise<Response> {
  return fetch(`https://api.github.com/repos/${path}`, {
    method: 'post',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.OCTOKIT_PAT ?? ''}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'trainlcd-worker',
    },
    body: JSON.stringify(body),
  });
}

/**
 * 原因が特定できているフィードバックについて、起票先の公開リポジトリを返す。
 * 特定できていない・公開に適さない場合は null（＝非公開リポジトリのみに起票）。
 *
 * - クラッシュレポートは対象外（スタックトレースを含み、内容の公開範囲が読めないため）
 * - スパム／スパム疑い／トリアージ失敗は原因を特定できていないので対象外
 * - 質問カテゴリは修正対象のコンポーネントが定まらないので対象外
 */
export function resolvePublicIssueRepo(
  aiReport: AIReport,
  opts: {
    reportType: Report['reportType'];
    triageFailed: boolean;
    needsSpamReview?: boolean;
  }
): string | null {
  if (opts.reportType !== 'feedback') return null;
  if (opts.triageFailed || aiReport.isSpam) return null;
  // スパム疑いで人手確認待ちのものを公開リポジトリに出さない
  if (opts.needsSpamReview) return null;
  if (!PUBLIC_ISSUE_CATEGORIES.includes(aiReport.category)) return null;
  if (!aiReport.component) return null;
  if (aiReport.componentConfidence < PUBLIC_ISSUE_MIN_CONFIDENCE) return null;
  return COMPONENT_REPOS[aiReport.component];
}

/**
 * 公開リポジトリに立てるスタブ Issue のタイトル。
 * 公開範囲にフィードバックの内容を出さないため、AI 要約もタイトルも使わず、
 * 非公開の管理 Issue 番号だけで表現する。
 */
export function buildPublicIssueTitle(internalIssueNumber: number): string {
  return `フィードバック対応: ${INTERNAL_REPO}#${internalIssueNumber}`;
}

/**
 * 公開リポジトリに立てるスタブ Issue の本文。
 * 意図的に、フィードバックの原文・AI 要約・タイトル・端末情報を一切含めない。
 * 内容を追うための手掛かりは非公開の管理チケットへの参照だけに限定する。
 */
export function buildPublicIssueBody(params: {
  internalIssueNumber: number;
  ticketId: string;
}): string {
  const { internalIssueNumber, ticketId } = params;
  return `
アプリから届いたフィードバックのトリアージで、原因が本リポジトリにあると推定されたため起票しています。

フィードバックの内容は公開リポジトリには掲載していません。原文・要約・端末情報などの詳細は、下記の非公開の管理チケットを参照してください。

## 管理チケット
- Issue: ${INTERNAL_REPO}#${internalIssueNumber}
- チケットID: \`${ticketId}\`
`.trim();
}

/**
 * 公開リポジトリへスタブ Issue を作成し、その URL を返す（失敗時は null）。
 * ここで throw すると queue が再試行して非公開 Issue が重複作成されるため、
 * 失敗はログに留める。
 */
async function createPublicIssue(
  env: Env,
  params: { repo: string; internalIssueNumber: number; ticketId: string }
): Promise<string | null> {
  const { repo, internalIssueNumber, ticketId } = params;
  try {
    // ラベルは公開リポジトリ側に存在しないと自動生成されてしまうため付けない。
    // 分類・優先度は非公開の管理 Issue 側のラベルで管理する。
    const res = await githubPost(env, `${repo}/issues`, {
      title: buildPublicIssueTitle(internalIssueNumber),
      body: buildPublicIssueBody({ internalIssueNumber, ticketId }),
      assignees: ['TinyKitten'],
    });
    if (res.status !== 201) {
      console.error('公開リポジトリへの起票に失敗', {
        repo,
        status: res.status,
        internalIssueNumber,
      });
      return null;
    }
    const created = (await res.json()) as { html_url: string };
    return created.html_url;
  } catch (err) {
    console.error('公開リポジトリへの起票に失敗', { repo, err });
    return null;
  }
}

/** 非公開の管理 Issue 側に、公開 Issue へのリンクをコメントで残す（失敗しても無視）。 */
async function linkPublicIssue(
  env: Env,
  internalIssueNumber: number,
  publicIssueUrl: string
): Promise<void> {
  try {
    const res = await githubPost(
      env,
      `${INTERNAL_REPO}/issues/${internalIssueNumber}/comments`,
      { body: `公開リポジトリに対応 Issue を起票しました: ${publicIssueUrl}` }
    );
    if (res.status !== 201) {
      console.error('管理 Issue への相互リンクコメントに失敗', {
        status: res.status,
        internalIssueNumber,
      });
    }
  } catch (err) {
    console.error('管理 Issue への相互リンクコメントに失敗', { err });
  }
}

// ---- 冪等化マーカー（STATE_KV） ----

/**
 * レポート 1 件の処理状態を STATE_KV に残すマーカー。
 *
 * GitHub Issue の作成後に例外が出ると queue が再試行し、同じフィードバックで
 * Issue がもう 1 件作られてしまう。report.id をキーに「どこまで終わったか」を
 * 永続化しておき、再試行では済んだ工程を飛ばす。
 *
 * 再試行のたびに AI を呼び直すとトリアージ結果がぶれ、起票済み Issue と通知の
 * 内容がずれるため、トリアージ結果もマーカーに含めて再利用する。
 */
export type TriageMarker = {
  version: 1;
  /** 非公開リポジトリに作成した Issue 番号（レスポンスの解析に失敗したときは null） */
  issueNumber: number | null;
  /** 作成した Issue の URL（同上） */
  issueUrl: string | null;
  /** 公開リポジトリに作成したスタブ Issue の URL（作っていなければ null） */
  publicIssueUrl: string | null;
  aiReport: AIReport;
  triageFailed: boolean;
  needsSpamReview: boolean;
  /** Discord 通知まで完了しているか */
  notified: boolean;
  updatedAt: string;
};

/**
 * マーカーの保持期間。queue の再試行自体は数分で終わるが、DLQ に落ちたメッセージを
 * 後日手動で流し直すことがあるため長めに取る。
 */
export const TRIAGE_MARKER_TTL_SECONDS = 60 * 60 * 24 * 30;

/** 処理済みマーカーの KV キー。 */
export const triageMarkerKey = (reportId: string): string =>
  `feedbackTriage:processed:${reportId}`;

/**
 * 処理済みマーカーを読む。KV 障害は握り潰さず上位へ伝播させる（＝再試行させる）。
 * ここで null に倒すと重複起票を防ぐという目的そのものを損なうため。
 * まだ副作用を出していない地点なので、throw しても Issue は重複しない。
 */
async function loadTriageMarker(
  env: Env,
  reportId: string
): Promise<TriageMarker | null> {
  const raw = await env.STATE_KV.get(triageMarkerKey(reportId), 'text');
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('feedbackTriage: 処理済みマーカーが壊れているため無視する', {
      reportId,
    });
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const marker = parsed as Partial<TriageMarker>;
  // aiReport を失っているマーカーは通知を組み立て直せないので無効扱いにする。
  if (!marker.aiReport || typeof marker.aiReport !== 'object') {
    console.error(
      'feedbackTriage: 処理済みマーカーの内容が不正なため無視する',
      {
        reportId,
      }
    );
    return null;
  }

  return {
    version: 1,
    issueNumber:
      typeof marker.issueNumber === 'number' ? marker.issueNumber : null,
    issueUrl: typeof marker.issueUrl === 'string' ? marker.issueUrl : null,
    publicIssueUrl:
      typeof marker.publicIssueUrl === 'string' ? marker.publicIssueUrl : null,
    aiReport: marker.aiReport,
    triageFailed: marker.triageFailed === true,
    needsSpamReview: marker.needsSpamReview === true,
    notified: marker.notified === true,
    updatedAt:
      typeof marker.updatedAt === 'string'
        ? marker.updatedAt
        : new Date().toISOString(),
  };
}

/**
 * 処理済みマーカーを書く。ここで throw すると「Issue は作成済みなのに再試行される」
 * という、まさに防ぎたい状態を作ってしまうため、失敗はログに留める。
 */
async function saveTriageMarker(
  env: Env,
  reportId: string,
  marker: Omit<TriageMarker, 'version' | 'updatedAt'>
): Promise<void> {
  const value: TriageMarker = {
    version: 1,
    ...marker,
    updatedAt: new Date().toISOString(),
  };
  try {
    await env.STATE_KV.put(triageMarkerKey(reportId), JSON.stringify(value), {
      expirationTtl: TRIAGE_MARKER_TTL_SECONDS,
    });
  } catch (err) {
    console.error('feedbackTriage: 処理済みマーカーの保存に失敗', {
      reportId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- トリアージ ----

type TriageOutcome = {
  aiReport: AIReport;
  triageFailed: boolean;
  needsSpamReview: boolean;
};

/**
 * フィードバック本文を AI でトリアージする。生成に失敗しても throw せず、
 * 「要約失敗」レポートに倒して原文を保全する（フィードバックを捨てないため）。
 */
async function triageFeedback(
  env: Env,
  report: Report
): Promise<TriageOutcome> {
  const fewshot = await getFewShotText(env);

  // 生成 → 最初のバランスした JSON を抽出。失敗したら厳格モードで数回まで再生成する。
  // ここで諦めても原文（report.description）は Issue 本文に必ず残すため、フィードバックは捨てない。
  const MAX_TRIAGE_ATTEMPTS = 3;
  let raw: unknown = null;
  let lastResponseLength = 0;
  for (let attempt = 1; attempt <= MAX_TRIAGE_ATTEMPTS; attempt++) {
    let resp: unknown = null;
    try {
      resp = await runTriage(env, fewshot, report.description, attempt > 1);
    } catch (err) {
      // JSON Mode を満たせない場合や AI 側の一時障害では env.AI.run が throw する。
      // ここで抜けると queue が再試行し、max_retries を使い切った時点でフィードバックが
      // 消えるため、生成失敗として扱って最終的に「要約失敗」で起票する（原文は残る）。
      console.warn('feedbackTriage: トリアージの推論呼び出しが失敗（再試行）', {
        reportId: report.id,
        attempt,
        maxAttempts: MAX_TRIAGE_ATTEMPTS,
        model: env.AI_TRIAGE_MODEL,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    lastResponseLength = responseLength(resp);
    raw = normalizeTriageResponse(resp);
    if (raw !== null) break;
    console.warn('feedbackTriage: モデル応答の JSON パースに失敗（再試行）', {
      reportId: report.id,
      attempt,
      maxAttempts: MAX_TRIAGE_ATTEMPTS,
      responseLength: lastResponseLength,
    });
  }

  let triageFailed = raw === null;
  let aiReport: AIReport;
  if (triageFailed) {
    // 生成に失敗しても破棄しない。原文を保全したまま、要約欄に失敗を明示して起票する。
    console.error(
      'feedbackTriage: トリアージ生成に失敗。要約失敗マーカー付きで起票する',
      { reportId: report.id }
    );
    aiReport = buildFailedReport(report.description, 72);
  } else {
    aiReport = coerceReport(raw, 72);
    // 非スパムで要約だけ空のときは観測ログを残す（coerceReport が title にフォールバック）。
    const rawSummary =
      raw && typeof raw === 'object'
        ? Object.entries(raw).find(
            ([k]) => k.toLowerCase().replace(/\s+/g, '').trim() === 'summary'
          )?.[1]
        : undefined;
    if (!aiReport.isSpam && String(rawSummary ?? '').trim() === '') {
      console.warn('feedbackTriage: モデルが summary を空/欠落で返却', {
        reportId: report.id,
        responseLength: lastResponseLength,
      });
    }

    // タイトルが未取得・日本語として破損している場合は、そのまま起票すると
    // Issue 一覧から内容を判別できない。失敗を明示するレポートに倒したうえで
    // ❓ Unknown Type を付け、破損率を追えるようにログを残す。
    const brokenTitleReason = findBrokenTitleReason(aiReport.title);
    if (brokenTitleReason) {
      console.warn(
        'feedbackTriage: 生成タイトルが使用不能（要約失敗として起票）',
        {
          reportId: report.id,
          reason: brokenTitleReason,
          model: env.AI_TRIAGE_MODEL,
          responseLength: lastResponseLength,
        }
      );
      aiReport = buildFailedReport(report.description, 72);
      triageFailed = true;
    }
  }

  const spamDecision = applySpamHeuristic(aiReport, report.description, {
    triageFailed,
  });
  aiReport = spamDecision.report;
  const { needsSpamReview } = spamDecision;
  if (needsSpamReview) {
    console.warn(
      'feedbackTriage: スパム判定がモデルとヒューリスティックで不一致（人手確認に回す）',
      { reportId: report.id, confidence: aiReport.confidence }
    );
  }

  return { aiReport, triageFailed, needsSpamReview };
}

// ---- Discord 通知 ----

/**
 * Discord へ通知する。GitHub Issue の作成後に呼ばれるため、ここで throw すると
 * queue ハンドラが再試行し、同一レポートで Issue が重複作成される。
 * webhook URL 未設定・HTTP エラーに加え、fetch 自体の失敗（ネットワーク断・DNS
 * 失敗・不正な URL）も含めて、あらゆる失敗をログに留めて握り潰す。
 */
async function notifyDiscord(
  env: Env,
  params: {
    report: Report;
    aiReport: AIReport;
    shouldTagTriage: boolean;
    categoryLabel?: string;
    triageLabel?: string;
    autoModeLabel?: string;
    issueUrl: string | null;
    publicIssueUrl: string | null;
  }
): Promise<void> {
  const {
    report,
    aiReport,
    shouldTagTriage,
    categoryLabel,
    triageLabel,
    autoModeLabel,
    issueUrl,
    publicIssueUrl,
  } = params;
  const {
    id,
    createdAt,
    description,
    deviceInfo,
    language,
    appVersion,
    reporterUid,
    stacktrace,
    reportType,
    imageUrl,
    autoModeEnabled,
    sentryEventId,
  } = report;

  try {
    const csWHUrl = env.DISCORD_CS_WEBHOOK_URL;
    const crashWHUrl = env.DISCORD_CRASH_WEBHOOK_URL;
    const issueUrlText = issueUrl ?? '不明';
    const embeds: DiscordEmbed[] = deviceInfo
      ? [
          {
            fields: [
              { name: 'チケットID', value: id },
              {
                name: '発行日時',
                value: dayjs(createdAt).format('YYYY/MM/DD HH:mm:ss'),
              },
              { name: 'AIによる要約', value: aiReport.summary },
              ...(shouldTagTriage && categoryLabel && triageLabel
                ? [
                    { name: 'カテゴリ', value: categoryLabel },
                    { name: 'トリアージ', value: triageLabel },
                  ]
                : []),
              {
                name: '端末モデル名',
                value: `${deviceInfo.brand} ${deviceInfo.modelName}(${deviceInfo.modelId})`,
              },
              {
                name: '端末のOS',
                value: `${deviceInfo.osName} ${deviceInfo.osVersion}`,
              },
              { name: '端末設定言語', value: deviceInfo.locale },
              { name: 'アプリの設定言語', value: language },
              { name: 'アプリのバージョン', value: appVersion },
              { name: 'レポーターUID', value: reporterUid },
              {
                name: 'オートモード',
                value:
                  autoModeLabel ??
                  (autoModeEnabled === false ? '無効' : '不明'),
              },
              { name: 'GitHub Issue', value: issueUrlText },
              ...(publicIssueUrl
                ? [{ name: '公開リポジトリ Issue', value: publicIssueUrl }]
                : []),
              { name: 'Sentry Event ID', value: sentryEventId ?? '不明' },
            ],
          },
        ]
      : [
          {
            fields: [
              { name: 'チケットID', value: id },
              {
                name: '発行日時',
                value: dayjs(createdAt).format('YYYY/MM/DD HH:mm:ss'),
              },
              { name: 'AIによる要約', value: aiReport.summary },
              ...(shouldTagTriage && categoryLabel && triageLabel
                ? [
                    { name: 'カテゴリ', value: categoryLabel },
                    { name: 'トリアージ', value: triageLabel },
                  ]
                : []),
              { name: 'アプリの設定言語', value: language },
              { name: 'アプリのバージョン', value: appVersion },
              { name: 'レポーターUID', value: reporterUid },
              {
                name: 'オートモード',
                value:
                  autoModeLabel ??
                  (autoModeEnabled === false ? '無効' : '不明'),
              },
              { name: 'GitHub Issue', value: issueUrlText },
              ...(publicIssueUrl
                ? [{ name: '公開リポジトリ Issue', value: publicIssueUrl }]
                : []),
            ],
          },
        ];

    const stacktraceTooLong = (stacktrace?.split('\n').length ?? 0) > 10;
    const content =
      reportType === 'feedback'
        ? `**🙏アプリから新しいフィードバックが届きまさした‼🙏**\n\`\`\`${description}\`\`\``
        : `**😭アプリからクラッシュレポートが届きまさした‼😭**\n**${description}**\n\`\`\`${stacktrace
            ?.split('\n')
            .slice(0, 10)
            .join('\n')}\n${stacktraceTooLong ? '...' : ''}\`\`\``;

    switch (reportType) {
      case 'feedback': {
        if (!csWHUrl) {
          console.error('DISCORD_CS_WEBHOOK_URL is not set; skipping notify');
          break;
        }
        const whRes = await fetch(csWHUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            embeds: embeds.map((emb) => ({
              ...emb,
              image: { url: imageUrl },
            })),
          }),
        });
        if (!whRes.ok) {
          const msg = await whRes.text().catch(() => '');
          console.error('Discord CS webhook failed', whRes.status, msg);
        }
        break;
      }
      case 'crash': {
        if (!crashWHUrl) {
          console.error(
            'DISCORD_CRASH_WEBHOOK_URL is not set; skipping notify'
          );
          break;
        }
        const whRes = await fetch(crashWHUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, embeds }),
        });
        if (!whRes.ok) {
          const msg = await whRes.text().catch(() => '');
          console.error('Discord Crash webhook failed', whRes.status, msg);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // fetch 自体の失敗（ネットワークエラー等）。再送出すると Issue が重複するため握り潰す。
    console.error('feedbackTriage: Discord 通知に失敗', {
      reportId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const processFeedbackMessage = async (
  data: FeedbackQueueMessage,
  env: Env
): Promise<void> => {
  if (!data?.report) return;
  const { report } = data;

  const {
    id,
    createdAt,
    description,
    deviceInfo,
    language,
    appVersion,
    reporterUid,
    stacktrace,
    reportType,
    imageUrl,
    appEdition,
    appClip,
    autoModeEnabled,
    sentryEventId,
  } = report;

  // 再試行や DLQ からの再投入で同じレポートが流れてきたとき、Issue を重複起票しない
  // ように、処理済みマーカーを見て済んだ工程を飛ばす。
  const marker = await loadTriageMarker(env, id);
  if (marker?.notified) {
    console.warn(
      'feedbackTriage: 処理済みのレポートを再受信したためスキップする',
      { reportId: id, issueNumber: marker.issueNumber }
    );
    return;
  }

  // 起票済みなら AI を呼び直さない。呼び直すと結果がぶれ、起票済み Issue と
  // Discord 通知の内容がずれるため、マーカーに残したトリアージ結果を使う。
  const { aiReport, triageFailed, needsSpamReview } = marker
    ? {
        aiReport: marker.aiReport,
        triageFailed: marker.triageFailed,
        needsSpamReview: marker.needsSpamReview,
      }
    : await triageFeedback(env, report);

  const createdAtText = dayjs(createdAt).format('YYYY/MM/DD HH:mm:ss');
  const osNameLabel = (() => {
    if (deviceInfo?.osName === 'iOS') return GITHUB_LABELS.PLATFORM_IOS;
    if (deviceInfo?.osName === 'iPadOS') return GITHUB_LABELS.PLATFORM_IPADOS;
    if (deviceInfo?.osName === 'Android') return GITHUB_LABELS.PLATFORM_ANDROID;
    return GITHUB_LABELS.PLATFORM_OTHER_OS;
  })();

  const autoModeLabel = autoModeEnabled
    ? GITHUB_LABELS.AUTOMODE_ENABLED
    : undefined;

  // トリアージ生成に失敗したときは誤ったカテゴリ/優先度を付けない。
  const shouldTagTriage =
    reportType === 'feedback' && !aiReport.isSpam && !triageFailed;
  const categoryLabel = shouldTagTriage
    ? CATEGORY_LABELS[aiReport.category]
    : undefined;
  const triageLabel = shouldTagTriage
    ? TRIAGE_LABELS[aiReport.triageLevel]
    : undefined;

  let issueNumber = marker?.issueNumber ?? null;
  let issueUrl = marker?.issueUrl ?? null;
  let publicIssueUrl = marker?.publicIssueUrl ?? null;

  if (!marker) {
    try {
      const res = await githubPost(env, `${INTERNAL_REPO}/issues`, {
        title: aiReport.title ?? '要約未取得',
        body: `
![Image](${imageUrl})


${'```'}
${description}
${'```'}

## AIによる要約
${aiReport.summary}

## チケットID
${id}

## 発行日時
${createdAtText}

## 端末モデル名
${deviceInfo?.brand} ${deviceInfo?.modelName}(${deviceInfo?.modelId})

## 端末のOS
${deviceInfo?.osName} ${deviceInfo?.osVersion}

## 端末設定言語
${deviceInfo?.locale}

## アプリの設定言語
${language}

## アプリのバージョン
${appVersion}

## オートモード
${autoModeEnabled ? '有効' : '無効'}

## スタックトレース
${'```'}
${stacktrace}
${'```'}

## Sentry Event ID
${sentryEventId}

## レポーターUID
${reporterUid}
        `.trim(),
        assignees: ['TinyKitten'],
        milestone: null,
        labels: [
          reportType === 'feedback' &&
            !aiReport.isSpam &&
            GITHUB_LABELS.FEEDBACK_TYPE,
          reportType === 'crash' && GITHUB_LABELS.CRASH_TYPE,
          appEdition === 'production' && GITHUB_LABELS.PRODUCTION_APP,
          appEdition === 'canary' && GITHUB_LABELS.CANARY_APP,
          appClip && GITHUB_LABELS.PLATFORM_APPCLIP,
          aiReport.isSpam && GITHUB_LABELS.SPAM_TYPE,
          (triageFailed || needsSpamReview) && GITHUB_LABELS.UNKNOWN_TYPE,
          osNameLabel,
          autoModeLabel,
          categoryLabel,
          triageLabel,
        ].filter(Boolean),
      });

      if (res.status !== 201) {
        console.error(await res.text().catch(() => ''));
        throw new Error(`GitHub API failed with status ${res.status}`);
      }

      // ここから先は Issue 作成済み。throw して再試行させると重複起票になるため、
      // レスポンスの解析に失敗しても続行し、分かった範囲をマーカーに残す。
      const created = (await res.json().catch((err: unknown) => {
        console.error('feedbackTriage: 起票レスポンスの解析に失敗', {
          reportId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })) as { html_url?: string; number?: number } | null;
      issueNumber = typeof created?.number === 'number' ? created.number : null;
      issueUrl =
        typeof created?.html_url === 'string' ? created.html_url : null;
    } catch (err) {
      // Issue 作成前の失敗。握りつぶすと queue ハンドラが ack してメッセージを失うため、
      // 再送出して再試行させる（この時点では Issue は作られていないので重複しない）。
      console.error(err);
      throw err;
    }

    // 原因コンポーネントが特定できている場合のみ、該当の公開リポジトリにも起票する。
    // 公開側に載せるのは管理 Issue 番号とチケットIDだけで、フィードバックの内容は含めない。
    // 起票後は管理 Issue 側にもコメントでリンクを残し、双方向に追えるようにする。
    const publicRepo = resolvePublicIssueRepo(aiReport, {
      reportType,
      triageFailed,
      needsSpamReview,
    });
    if (publicRepo && issueNumber !== null) {
      publicIssueUrl = await createPublicIssue(env, {
        repo: publicRepo,
        internalIssueNumber: issueNumber,
        ticketId: id,
      });
      if (publicIssueUrl) {
        await linkPublicIssue(env, issueNumber, publicIssueUrl);
      }
    }

    // 起票済みであることを先に永続化する。この後で落ちても、再試行は通知から再開する。
    await saveTriageMarker(env, id, {
      issueNumber,
      issueUrl,
      publicIssueUrl,
      aiReport,
      triageFailed,
      needsSpamReview,
      notified: false,
    });
  }

  await notifyDiscord(env, {
    report,
    aiReport,
    shouldTagTriage,
    categoryLabel,
    triageLabel,
    autoModeLabel,
    issueUrl,
    publicIssueUrl,
  });

  await saveTriageMarker(env, id, {
    issueNumber,
    issueUrl,
    publicIssueUrl,
    aiReport,
    triageFailed,
    needsSpamReview,
    notified: true,
  });
};
