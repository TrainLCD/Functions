import type { AIReport } from '../models/ai';
import type { Report } from '../models/feedback';
import type { FeedbackQueueMessage } from '../types';
import {
  applySpamHeuristic,
  buildFailedReport,
  buildPublicIssueBody,
  buildPublicIssueTitle,
  coerceReport,
  extractReportJson,
  findBrokenTitleReason,
  isUnusableTitle,
  looksLikeSpam,
  MISSING_TITLE,
  NON_ACTIONABLE_TITLE,
  PUBLIC_ISSUE_MIN_CONFIDENCE,
  pickModelResponse,
  processFeedbackMessage,
  resolvePublicIssueRepo,
  SPAM_OVERRIDE_MAX_CONFIDENCE,
  TRIAGE_FAILED_SUMMARY,
  triageMarkerKey,
} from './feedbackTriage';

describe('coerceReport', () => {
  it('returns defaults when category and triageLevel are missing', () => {
    const r = coerceReport({ title: 'タイトル', summary: 'サマリ' });
    expect(r.category).toBe('question');
    expect(r.triageLevel).toBe('medium');
  });

  it('maps canonical category and triageLevel values', () => {
    const r = coerceReport({
      title: 't',
      summary: 's',
      category: 'bug',
      triageLevel: 'urgent',
    });
    expect(r.category).toBe('bug');
    expect(r.triageLevel).toBe('urgent');
  });

  it('maps synonyms to canonical values', () => {
    const r = coerceReport({
      title: 't',
      summary: 's',
      category: 'feature',
      triageLevel: 'critical',
    });
    expect(r.category).toBe('feature_request');
    expect(r.triageLevel).toBe('urgent');
  });

  it('normalizes case, whitespace, and hyphens', () => {
    const r = coerceReport({
      title: 't',
      summary: 's',
      category: '  Feature-Request  ',
      triageLevel: '  P0  ',
    });
    expect(r.category).toBe('feature_request');
    expect(r.triageLevel).toBe('urgent');
  });

  it('maps P-level triage aliases', () => {
    expect(
      coerceReport({ category: 'bug', triageLevel: 'P1' }).triageLevel
    ).toBe('high');
    expect(
      coerceReport({ category: 'bug', triageLevel: 'p2' }).triageLevel
    ).toBe('medium');
    expect(
      coerceReport({ category: 'bug', triageLevel: 'P3' }).triageLevel
    ).toBe('low');
  });

  it('falls back to defaults for unknown values', () => {
    const r = coerceReport({
      title: 't',
      summary: 's',
      category: 'nonsense',
      triageLevel: 'whatever',
    });
    expect(r.category).toBe('question');
    expect(r.triageLevel).toBe('medium');
  });

  it('accepts case-insensitive key names from model output', () => {
    const r = coerceReport({
      Title: 't',
      Summary: 's',
      Category: 'Improvement',
      TriageLevel: 'HIGH',
    });
    expect(r.category).toBe('improvement');
    expect(r.triageLevel).toBe('high');
  });

  it('still parses existing fields (title truncation, labels, confidence, reason)', () => {
    const longTitle = 'あ'.repeat(100);
    const r = coerceReport({
      title: longTitle,
      summary: 's',
      labels: ['ui', 'performance', 42],
      confidence: 0.8,
      reason: 'because',
    });
    expect(r.title.length).toBeLessThanOrEqual(72);
    expect(r.labels).toEqual(['ui', 'performance']);
    expect(r.confidence).toBe(0.8);
    expect(r.reason).toBe('because');
  });

  it('falls back to the title when summary is empty', () => {
    const r = coerceReport({ title: 'タイトルだけ', summary: '' });
    expect(r.summary).toBe('タイトルだけ');
  });

  it('falls back to the default title when both title and summary are empty', () => {
    const r = coerceReport({});
    expect(r.title).toBe(MISSING_TITLE);
    // タイトル未取得を要約に伝播させると両方が同時に無意味になるため、失敗を明示する
    expect(r.summary).toBe(TRIAGE_FAILED_SUMMARY);
  });

  it('does not propagate a broken title into the summary', () => {
    const r = coerceReport({ title: 'ををををを', summary: '' });
    expect(r.summary).toBe(TRIAGE_FAILED_SUMMARY);
  });

  it('supports question and improvement synonyms', () => {
    expect(coerceReport({ category: 'help' }).category).toBe('question');
    expect(coerceReport({ category: 'enhancement' }).category).toBe(
      'improvement'
    );
  });

  it('感謝・称賛は praise として扱う（スパムに落とさない）', () => {
    for (const raw of ['praise', 'Thanks', ' compliment ', 'gratitude']) {
      const r = coerceReport({ title: 't', summary: 's', category: raw });
      expect(r.category).toBe('praise');
      expect(r.isSpam).toBe(false);
    }
  });
});

describe('looksLikeSpam', () => {
  it('treats actionable feedback as not spam', () => {
    expect(looksLikeSpam('表示がおかしいので修正してほしい')).toBe(false);
  });

  it('flags announcement-style transcripts as spam', () => {
    expect(
      looksLikeSpam(
        '次は東京、東京です。お乗り換えのご案内をいたします。停車駅は品川方面'
      )
    ).toBe(true);
  });
});

describe('extractReportJson', () => {
  it('parses a single clean JSON object', () => {
    const r = extractReportJson('{"title":"t","isSpam":false}') as Record<
      string,
      unknown
    >;
    expect(r.title).toBe('t');
  });

  it('returns only the first balanced object when the model echoes extras', () => {
    // 小型モデルが few-shot を真似て複数オブジェクト/プロンプトを続けて吐くケース
    const text =
      '{"title":"first","isSpam":false}\nInput: ...\nOutput:\n{"title":"second"}';
    const r = extractReportJson(text) as Record<string, unknown>;
    expect(r.title).toBe('first');
  });

  it('strips code fences', () => {
    const r = extractReportJson(
      '```json\n{"title":"fenced","isSpam":true}\n```'
    ) as Record<string, unknown>;
    expect(r.title).toBe('fenced');
  });

  it('repairs a trailing comma', () => {
    const r = extractReportJson('{"title":"t","labels":["a","b"],}') as Record<
      string,
      unknown
    >;
    expect(r.title).toBe('t');
  });

  it('ignores braces inside string values', () => {
    const r = extractReportJson('{"title":"a } b","isSpam":false}') as Record<
      string,
      unknown
    >;
    expect(r.title).toBe('a } b');
  });

  it('returns null when output is truncated before the closing brace', () => {
    expect(extractReportJson('{"title":"t","summary":"途中で')).toBeNull();
  });

  it('returns null when there is no JSON object', () => {
    expect(extractReportJson('ごめんなさい、出力できません')).toBeNull();
    expect(extractReportJson('')).toBeNull();
  });
});

describe('buildFailedReport', () => {
  it('preserves the feedback as a marker instead of dropping it', () => {
    const r = buildFailedReport('音が鳴らないので直してほしいです');
    expect(r.summary).toBe(TRIAGE_FAILED_SUMMARY);
    expect(r.isSpam).toBe(false);
    expect(r.title.startsWith('要約失敗: ')).toBe(true);
    expect(r.title).toContain('音が鳴らない');
  });

  it('truncates the title to the max length', () => {
    const r = buildFailedReport('あ'.repeat(200), 72);
    expect(r.title.length).toBeLessThanOrEqual(72);
  });

  it('handles empty description', () => {
    const r = buildFailedReport('');
    expect(r.title).toBe('要約失敗: （本文なし）');
    expect(r.summary).toBe(TRIAGE_FAILED_SUMMARY);
  });
});

describe('coerceReport（原因コンポーネント）', () => {
  it('canonical な component と信頼度を読み取る', () => {
    const r = coerceReport({
      title: 't',
      summary: 's',
      category: 'bug',
      component: 'station_api',
      componentConfidence: 0.9,
    });
    expect(r.component).toBe('station_api');
    expect(r.componentConfidence).toBe(0.9);
  });

  it('表記ゆれを正規化する', () => {
    expect(coerceReport({ component: 'MobileApp' }).component).toBe(
      'mobile_app'
    );
    expect(coerceReport({ component: ' iOS ' }).component).toBe('mobile_app');
    expect(coerceReport({ component: 'Web' }).component).toBe('website');
    expect(coerceReport({ component: 'workers' }).component).toBe('functions');
  });

  it('unknown・未知の値・欠落は null にする', () => {
    expect(coerceReport({ component: 'unknown' }).component).toBeNull();
    expect(coerceReport({ component: 'なにか' }).component).toBeNull();
    expect(coerceReport({}).component).toBeNull();
  });

  it('component が特定できないときは信頼度を 0 に落とす', () => {
    const r = coerceReport({ component: 'unknown', componentConfidence: 0.95 });
    expect(r.component).toBeNull();
    expect(r.componentConfidence).toBe(0);
  });

  it('component はあるが信頼度が欠落しているときは 0 とみなす', () => {
    const r = coerceReport({ component: 'functions' });
    expect(r.componentConfidence).toBe(0);
  });

  it('0..1 の範囲外の信頼度は信用せず既定値に倒す', () => {
    // パーセント表記（90）や負値は、そのまま通すと閾値判定をすり抜けて
    // 公開リポジトリへ起票されてしまう
    for (const bad of [90, 1.2, -0.5]) {
      const r = coerceReport({
        component: 'station_api',
        // category を省くと question 扱いになり、信頼度に到達する前に弾かれてしまう
        category: 'bug',
        componentConfidence: bad,
        confidence: bad,
      });
      expect(r.componentConfidence).toBe(0);
      expect(r.confidence).toBe(0.5);
      expect(
        resolvePublicIssueRepo(r, {
          reportType: 'feedback',
          triageFailed: false,
        })
      ).toBeNull();
    }
  });

  it('数値でない信頼度は既定値に倒す（Number() の型強制を通さない）', () => {
    // Number(true) === 1、Number([1]) === 1 なので、型で絞らないと閾値を通過する
    for (const bad of [true, [1], null, '', ' ', {}]) {
      const r = coerceReport({
        component: 'station_api',
        category: 'bug',
        componentConfidence: bad,
        confidence: bad,
      });
      expect(r.componentConfidence).toBe(0);
      expect(r.confidence).toBe(0.5);
      expect(
        resolvePublicIssueRepo(r, {
          reportType: 'feedback',
          triageFailed: false,
        })
      ).toBeNull();
    }
  });

  it('数値だけの文字列は受け付ける', () => {
    const r = coerceReport({
      component: 'station_api',
      category: 'bug',
      componentConfidence: '0.9',
    });
    expect(r.componentConfidence).toBe(0.9);
  });

  it('境界値の 0 と 1 は受け付ける', () => {
    expect(
      coerceReport({ component: 'website', componentConfidence: 1 })
        .componentConfidence
    ).toBe(1);
    expect(
      coerceReport({ component: 'website', componentConfidence: 0 })
        .componentConfidence
    ).toBe(0);
  });
});

const baseReport = (overrides: Partial<AIReport> = {}): AIReport => ({
  title: 'タイトル',
  summary: 'サマリ',
  isSpam: false,
  labels: [],
  confidence: 0.9,
  reason: 'reason',
  category: 'bug',
  triageLevel: 'high',
  component: 'mobile_app',
  componentConfidence: 0.9,
  ...overrides,
});

describe('resolvePublicIssueRepo', () => {
  const opts = { reportType: 'feedback' as const, triageFailed: false };

  it('原因コンポーネントに対応する公開リポジトリを返す', () => {
    expect(resolvePublicIssueRepo(baseReport(), opts)).toBe(
      'TrainLCD/MobileApp'
    );
    expect(
      resolvePublicIssueRepo(baseReport({ component: 'station_api' }), opts)
    ).toBe('TrainLCD/StationAPI');
    expect(
      resolvePublicIssueRepo(baseReport({ component: 'functions' }), opts)
    ).toBe('TrainLCD/Functions');
    expect(
      resolvePublicIssueRepo(baseReport({ component: 'website' }), opts)
    ).toBe('TrainLCD/Website');
  });

  it('改善・要望も対象にする', () => {
    expect(
      resolvePublicIssueRepo(baseReport({ category: 'improvement' }), opts)
    ).toBe('TrainLCD/MobileApp');
    expect(
      resolvePublicIssueRepo(baseReport({ category: 'feature_request' }), opts)
    ).toBe('TrainLCD/MobileApp');
  });

  it('原因が特定できていなければ起票しない', () => {
    expect(
      resolvePublicIssueRepo(
        baseReport({ component: null, componentConfidence: 0 }),
        opts
      )
    ).toBeNull();
  });

  it('信頼度が閾値未満なら起票しない', () => {
    expect(
      resolvePublicIssueRepo(
        baseReport({ componentConfidence: PUBLIC_ISSUE_MIN_CONFIDENCE - 0.01 }),
        opts
      )
    ).toBeNull();
    expect(
      resolvePublicIssueRepo(
        baseReport({ componentConfidence: PUBLIC_ISSUE_MIN_CONFIDENCE }),
        opts
      )
    ).toBe('TrainLCD/MobileApp');
  });

  it('スパム・質問・トリアージ失敗・クラッシュは起票しない', () => {
    expect(
      resolvePublicIssueRepo(baseReport({ isSpam: true }), opts)
    ).toBeNull();
    expect(
      resolvePublicIssueRepo(baseReport({ category: 'question' }), opts)
    ).toBeNull();
    expect(
      resolvePublicIssueRepo(baseReport(), { ...opts, triageFailed: true })
    ).toBeNull();
    expect(
      resolvePublicIssueRepo(baseReport(), { ...opts, reportType: 'crash' })
    ).toBeNull();
  });
});

describe('公開リポジトリ用の Issue 本文', () => {
  const ticketId = 'a1b2c3d4-0000-4444-8888-abcdefabcdef';
  const body = buildPublicIssueBody({ internalIssueNumber: 123, ticketId });

  it('管理 Issue 番号とチケットIDを紐づける', () => {
    expect(buildPublicIssueTitle(123)).toContain('TrainLCD/Issues#123');
    expect(body).toContain('TrainLCD/Issues#123');
    expect(body).toContain(ticketId);
  });

  it('フィードバック由来の情報を一切含めない', () => {
    const report = baseReport({
      title: '駅名が誤って表示される',
      summary: '山手線で駅名が1つずれて表示されるという報告',
    });
    const rendered = `${buildPublicIssueTitle(123)}\n${body}`;
    expect(rendered).not.toContain(report.title);
    expect(rendered).not.toContain(report.summary);
    expect(rendered).not.toContain(report.reason);
  });
});

describe('looksLikeSpam（正当な報告の誤判定）', () => {
  // 実フィードバックは非公開のため、同等の語彙構成を持つ合成文で確認する
  it('停車駅・方面・路線名を含むデータ不備の報告をスパムにしない', () => {
    expect(
      looksLikeSpam('架空線の停車駅が違います。仮駅と例駅にも停車するはずです')
    ).toBe(false);
    expect(looksLikeSpam('行き先方面の案内が実際と異なります')).toBe(false);
    expect(looksLikeSpam('架空線の停車駅、仮駅・例駅が抜けています')).toBe(
      false
    );
    expect(looksLikeSpam('種別が反映されていないようです')).toBe(false);
    expect(looksLikeSpam('乗り換え路線を追加してほしいです')).toBe(false);
    expect(looksLikeSpam('駅ナンバリングの表記がおかしいです')).toBe(false);
  });

  it('放送定型句を伴わない停車駅・方面の言及だけでは加点しない', () => {
    // ACTIONABLE に一致しない書き方でも、放送の書き起こしでなければスパムにしない
    expect(looksLikeSpam('架空線の停車駅と方面の情報について')).toBe(false);
  });

  it('車内放送の書き起こしは引き続きスパムとして扱う', () => {
    expect(
      looksLikeSpam(
        '次は仮駅、仮駅です。お出口は左側です。ご利用ありがとうございます。'
      )
    ).toBe(true);
    expect(
      looksLikeSpam(
        '次は仮駅方面、停車駅は例駅、見本駅です。お乗り換えのご案内'
      )
    ).toBe(true);
  });
});

describe('applySpamHeuristic', () => {
  const notSpam = (confidence: number): AIReport => ({
    title: '停車駅の誤りについて',
    summary: 'サマリ',
    isSpam: false,
    labels: ['bug'],
    confidence,
    reason: 'reason',
    category: 'bug',
    triageLevel: 'high',
    component: 'station_api',
    componentConfidence: 0.9,
  });
  const transcript =
    '次は仮駅、仮駅です。お出口は左側です。ご利用ありがとうございます。';

  it('モデルが確信を持って非スパムと判定していれば分類を維持し、人手確認に回す', () => {
    const { report, needsSpamReview } = applySpamHeuristic(
      notSpam(SPAM_OVERRIDE_MAX_CONFIDENCE),
      transcript,
      { triageFailed: false }
    );
    expect(needsSpamReview).toBe(true);
    expect(report.isSpam).toBe(false);
    expect(report.title).toBe('停車駅の誤りについて');
    expect(report.labels).toEqual(['bug']);
    expect(report.category).toBe('bug');
  });

  it('モデルの確信度が低い場合はヒューリスティックでスパムに倒す', () => {
    const { report, needsSpamReview } = applySpamHeuristic(
      notSpam(SPAM_OVERRIDE_MAX_CONFIDENCE - 0.01),
      transcript,
      { triageFailed: false }
    );
    expect(needsSpamReview).toBe(false);
    expect(report.isSpam).toBe(true);
    expect(report.title).toBe(NON_ACTIONABLE_TITLE);
    expect(report.labels).toEqual([]);
  });

  it('正当な報告には何もしない', () => {
    const input = notSpam(0.9);
    const { report, needsSpamReview } = applySpamHeuristic(
      input,
      '架空線の停車駅が違います',
      { triageFailed: false }
    );
    expect(needsSpamReview).toBe(false);
    expect(report).toBe(input);
  });

  it('トリアージ失敗のレポートは上書きしない（失敗の事実を残す）', () => {
    const failed = buildFailedReport(transcript, 72);
    const { report, needsSpamReview } = applySpamHeuristic(failed, transcript, {
      triageFailed: true,
    });
    expect(needsSpamReview).toBe(false);
    expect(report).toBe(failed);
    expect(report.summary).toBe(TRIAGE_FAILED_SUMMARY);
  });

  it('モデル自身がスパムと判定したものはそのまま', () => {
    const spam = { ...notSpam(0.9), isSpam: true };
    const { report, needsSpamReview } = applySpamHeuristic(spam, transcript, {
      triageFailed: false,
    });
    expect(needsSpamReview).toBe(false);
    expect(report).toBe(spam);
  });
});

describe('findBrokenTitleReason', () => {
  it('正常な日本語タイトルは通す', () => {
    for (const title of [
      '自動アナウンスが途中で停止する不具合',
      // 異なる助詞の連結は正常な日本語（誤検知の回帰テスト）
      '駅名が反映されないのでは？という報告',
      'そのものには問題がない旨の報告',
      '路線図のダークモード対応要望',
      '特定駅が検索に出ず駅名表記も誤り',
      'オートモード時に駅ナンバリングがずれる',
      'Auto mode stops announcing station names',
    ]) {
      expect(findBrokenTitleReason(title)).toBeNull();
    }
  });

  it('未取得・空・記号のみを検知する', () => {
    expect(findBrokenTitleReason(MISSING_TITLE)).toBe('missing');
    expect(findBrokenTitleReason('')).toBe('empty');
    expect(findBrokenTitleReason('   ')).toBe('empty');
    expect(findBrokenTitleReason('！！！…')).toBe('no_word_char');
  });

  it('破損した生成結果を検知する', () => {
    expect(findBrokenTitleReason('駅名が\uFFFD示される')).toBe(
      'replacement_char'
    );
    expect(findBrokenTitleReason('繧医↓縺ゅk陦ィ遉ｺ')).toBe('mojibake_kanji');
    expect(findBrokenTitleReason('駅名ををををが変')).toBe('char_repeat');
    expect(findBrokenTitleReason('表示表示表示がおかしい')).toBe(
      'phrase_repeat'
    );
    expect(findBrokenTitleReason('駅名ををを変わる')).toBe('particle_run');
    expect(findBrokenTitleReason('역명이 잘못 표시됨')).toBe('foreign_script');
  });

  it('isUnusableTitle は真偽値を返す', () => {
    expect(isUnusableTitle('正常なタイトル')).toBe(false);
    expect(isUnusableTitle(MISSING_TITLE)).toBe(true);
  });
});

describe('pickModelResponse', () => {
  it('従来の Workers AI 形式（response）を取り出す', () => {
    expect(pickModelResponse({ response: { title: 't' } })).toEqual({
      title: 't',
    });
    expect(pickModelResponse({ response: '{"title":"t"}' })).toBe(
      '{"title":"t"}'
    );
  });

  it('OpenAI 互換形式（choices[0].message.content）を取り出す', () => {
    // gemma-4 系は response を返さず choices のみ。ここを見落とすと全件失敗する
    const raw = {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '{"title":"駅名がずれる"}', reasoning: '...' },
        },
      ],
      usage: { completion_tokens: 892 },
    };
    expect(pickModelResponse(raw)).toBe('{"title":"駅名がずれる"}');
  });

  it('response があればそちらを優先する', () => {
    const raw = {
      response: { title: 'A' },
      choices: [{ message: { content: '{"title":"B"}' } }],
    };
    expect(pickModelResponse(raw)).toEqual({ title: 'A' });
  });

  it('取り出せない形は null', () => {
    expect(pickModelResponse(null)).toBeNull();
    expect(pickModelResponse('text')).toBeNull();
    expect(pickModelResponse({})).toBeNull();
    expect(pickModelResponse({ choices: [] })).toBeNull();
    expect(pickModelResponse({ choices: [{ message: {} }] })).toBeNull();
  });

  it('取り出した文字列は既存の JSON 抽出でパースできる', () => {
    const content = '{\n  "title": "駅名がずれる",\n  "isSpam": false\n}';
    const picked = pickModelResponse({
      choices: [{ message: { content } }],
    }) as string;
    expect(extractReportJson(picked)).toEqual({
      title: '駅名がずれる',
      isSpam: false,
    });
  });
});

describe('processFeedbackMessage（再試行時の冪等化）', () => {
  const ISSUES_API = 'https://api.github.com/repos/TrainLCD/Issues/issues';
  const CS_WEBHOOK = 'https://discord.example.com/webhooks/cs';

  const AI_JSON = JSON.stringify({
    title: 'タイトル',
    summary: '要約',
    isSpam: false,
    labels: [],
    confidence: 0.9,
    reason: '理由',
    category: 'question',
    triageLevel: 'medium',
    component: null,
    componentConfidence: 0,
  });

  const report: Report = {
    id: 'report-1',
    reportType: 'feedback',
    description: '駅の表示がおかしいので直してほしいです',
    stacktrace: undefined,
    resolved: false,
    resolvedReason: '',
    language: 'ja-JP',
    appVersion: '1.0.0',
    deviceInfo: null,
    resolverUid: '',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    reporterUid: 'uid-1',
    imageUrl: null,
    appEdition: 'production',
    appClip: false,
    autoModeEnabled: false,
  };

  // KV の同一キー書き込み制限を守るための待ちがテスト間に持ち越されないよう、
  // レポートIDはテストごとに変える。
  let seq = 0;
  const makeMessage = (): FeedbackQueueMessage => {
    seq += 1;
    return {
      id: `msg-${seq}`,
      receivedAt: '2024-01-01T00:00:00.000Z',
      report: { ...report, id: `report-${seq}` },
      version: 1,
    };
  };

  // biome-ignore lint/suspicious/noExplicitAny: テスト用の最小 Env スタブ
  type TestEnv = any;

  const createEnv = (): { env: TestEnv; store: Map<string, string> } => {
    const store = new Map<string, string>();
    return {
      env: {
        AI: { run: jest.fn().mockResolvedValue({ response: AI_JSON }) },
        CONFIG_KV: {
          get: jest
            .fn()
            .mockResolvedValue('{"input":"入力例","output":"出力例"}'),
        },
        STATE_KV: {
          get: jest.fn(async (key: string) => store.get(key) ?? null),
          put: jest.fn(async (key: string, value: string) => {
            store.set(key, value);
          }),
        },
        AI_TRIAGE_MODEL: 'test-model',
        FEW_SHOT_KV_KEY: 'fewshot',
        FEW_SHOT_LIMIT: '1',
        FEW_SHOT_PER_EX_MAX: '800',
        OCTOKIT_PAT: 'pat',
        DISCORD_CS_WEBHOOK_URL: CS_WEBHOOK,
        DISCORD_CRASH_WEBHOOK_URL: '',
      },
      store,
    };
  };

  const marker = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      issueNumber: 42,
      issueUrl: 'https://github.com/TrainLCD/Issues/issues/42',
      publicIssueUrl: null,
      aiReport: JSON.parse(AI_JSON),
      triageFailed: false,
      needsSpamReview: false,
      notified: false,
      updatedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    });

  const originalFetch = global.fetch;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const githubCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.filter((c) => String(c[0]) === ISSUES_API);
  const discordCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.filter((c) => String(c[0]) === CS_WEBHOOK);

  it('起票直後と通知後のマーカー保存を 1 秒以上空ける（KV の同一キー制限）', async () => {
    const msg = makeMessage();
    const { env } = createEnv();
    const writeAt: number[] = [];
    const originalPut = env.STATE_KV.put;
    env.STATE_KV.put = jest.fn(async (key: string, value: string) => {
      writeAt.push(Date.now());
      return originalPut(key, value);
    });
    const fetchMock = jest.fn(async (input: unknown) => {
      if (String(input) === ISSUES_API) {
        return new Response(
          JSON.stringify({
            html_url: 'https://github.com/TrainLCD/Issues/issues/42',
            number: 42,
          }),
          { status: 201 }
        );
      }
      return new Response(null, { status: 204 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await processFeedbackMessage(msg, env);

    expect(writeAt).toHaveLength(2);
    expect(writeAt[1] - writeAt[0]).toBeGreaterThanOrEqual(1000);
  });

  it('Discord への fetch が throw しても再送出しない（再試行による重複起票を防ぐ）', async () => {
    const msg = makeMessage();
    const { env, store } = createEnv();
    const fetchMock = jest.fn(async (input: unknown) => {
      if (String(input) === ISSUES_API) {
        return new Response(
          JSON.stringify({
            html_url: 'https://github.com/TrainLCD/Issues/issues/42',
            number: 42,
          }),
          { status: 201 }
        );
      }
      throw new TypeError('network error');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(processFeedbackMessage(msg, env)).resolves.toBeUndefined();

    expect(githubCalls(fetchMock)).toHaveLength(1);
    const saved = JSON.parse(store.get(triageMarkerKey(msg.report.id)) ?? '{}');
    expect(saved.issueNumber).toBe(42);
    // 未通知のまま残し、再投入したときに通知だけやり直せるようにする
    expect(saved.notified).toBe(false);
  });

  it('Discord が HTTP エラーを返したときも未通知のまま記録する', async () => {
    const msg = makeMessage();
    const { env, store } = createEnv();
    store.set(triageMarkerKey(msg.report.id), marker());
    const fetchMock = jest.fn(
      async () => new Response('rate limited', { status: 429 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await processFeedbackMessage(msg, env);

    expect(discordCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(store.get(triageMarkerKey(msg.report.id)) ?? '{}').notified
    ).toBe(false);
  });

  it('起票済みマーカーがあれば Issue を作り直さず、通知だけやり直す', async () => {
    const msg = makeMessage();
    const { env, store } = createEnv();
    store.set(triageMarkerKey(msg.report.id), marker());
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await processFeedbackMessage(msg, env);

    expect(githubCalls(fetchMock)).toHaveLength(0);
    // 再試行でトリアージをやり直すと Issue と通知の内容がずれるため、AI も呼ばない
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(discordCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(store.get(triageMarkerKey(msg.report.id)) ?? '{}').notified
    ).toBe(true);
  });

  it('マーカー保存が一度失敗しても書き直し、throw しない', async () => {
    const msg = makeMessage();
    const { env, store } = createEnv();
    store.set(triageMarkerKey(msg.report.id), marker());
    let puts = 0;
    env.STATE_KV.put = jest.fn(async (key: string, value: string) => {
      puts += 1;
      if (puts === 1) throw new Error('KV unavailable');
      store.set(key, value);
    });
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(processFeedbackMessage(msg, env)).resolves.toBeUndefined();

    expect(puts).toBe(2);
    expect(
      JSON.parse(store.get(triageMarkerKey(msg.report.id)) ?? '{}').notified
    ).toBe(true);
  });

  it('通知まで完了したマーカーがあれば何もしない', async () => {
    const msg = makeMessage();
    const { env, store } = createEnv();
    store.set(triageMarkerKey(msg.report.id), marker({ notified: true }));
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await processFeedbackMessage(msg, env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
  });

  it('起票前の失敗は再送出し、マーカーを残さない（メッセージを失わないため）', async () => {
    const msg = makeMessage();
    const { env, store } = createEnv();
    const fetchMock = jest.fn(
      async () => new Response('{"message":"boom"}', { status: 500 })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(processFeedbackMessage(msg, env)).rejects.toThrow(
      'GitHub API failed with status 500'
    );
    expect(store.has(triageMarkerKey(msg.report.id))).toBe(false);
  });
});
