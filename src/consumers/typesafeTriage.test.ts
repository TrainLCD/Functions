import { type Answer, compose } from './typesafeTriage';

/** 既定は「正当な不具合報告」。各テストで必要な軸だけ上書きする */
function answers(
  over: {
    spam?: number;
    announcement?: number;
    praise?: number;
    crash?: number;
    stationData?: number;
    category?: string;
    categoryConf?: number;
    component?: string;
    componentConf?: number;
    severity?: number;
    actionability?: number;
  } = {}
): Record<string, Answer> {
  const noul = (v: number): Answer => ({ type: 'noul', noul: v });
  return {
    is_spam: noul(over.spam ?? 0.05),
    is_announcement_transcript: noul(over.announcement ?? 0.05),
    is_praise_only: noul(over.praise ?? 0.05),
    is_crash_or_data_loss: noul(over.crash ?? 0.05),
    mentions_station_data: noul(over.stationData ?? 0.05),
    category: {
      type: 'choice',
      choice: over.category ?? 'bug',
      probabilities: {},
      confidence: over.categoryConf ?? 0.9,
    },
    component: {
      type: 'choice',
      choice: over.component ?? 'mobile_app',
      probabilities: {},
      confidence: over.componentConf ?? 0.9,
    },
    severity: {
      type: 'score',
      score: over.severity ?? 1.0,
      legend: {},
      probabilities: {},
      confidence: 0.8,
    },
    actionability: {
      type: 'score',
      score: over.actionability ?? 1.0,
      legend: {},
      probabilities: {},
      confidence: 0.8,
    },
  };
}

describe('スパム判定', () => {
  it('車内放送の書き起こしは、謝辞を含んでいてもスパムにする', () => {
    // 放送文は「ご利用くださいましてありがとうございます」を含むため
    // is_praise_only が上がる。感謝ゲートで弾くと放送が素通りする。
    const v = compose(
      answers({ announcement: 0.89, praise: 0.65, spam: 0.51 })
    );
    expect(v.isSpam).toBe(true);
  });

  it('スパム信号が明確なら、is_praise_only がちょうど 0.5 でもスパムにする', () => {
    // 固定値 praise < 0.5 と比べていたため、この組み合わせが素通りしていた
    const v = compose(answers({ spam: 0.96, praise: 0.5 }));
    expect(v.isSpam).toBe(true);
  });

  it('感謝の方がスパムらしさより強いときはスパムにしない', () => {
    const v = compose(answers({ spam: 0.55, praise: 0.9, category: 'praise' }));
    expect(v.isSpam).toBe(false);
  });

  it('正当な報告はスパムにしない', () => {
    expect(compose(answers()).isSpam).toBe(false);
  });

  it('スパムのときは category と component を伏せる', () => {
    const v = compose(
      answers({ spam: 0.9, category: 'bug', component: 'mobile_app' })
    );
    expect(v.category).toBe('question');
    expect(v.component).toBe('unknown');
    expect(v.triageLevel).toBe('low');
  });
});

describe('triageLevel', () => {
  it('クラッシュとデータ消失は severity によらず urgent', () => {
    const v = compose(answers({ crash: 0.8, severity: 0.1 }));
    expect(v.triageLevel).toBe('urgent');
  });

  it('bug は severity で段階を決める', () => {
    expect(compose(answers({ severity: 2.5 })).triageLevel).toBe('urgent');
    expect(compose(answers({ severity: 1.9 })).triageLevel).toBe('high');
    expect(compose(answers({ severity: 1.0 })).triageLevel).toBe('medium');
    expect(compose(answers({ severity: 0.2 })).triageLevel).toBe('low');
  });

  it('不具合でない要望は、severity が高くても medium を超えない', () => {
    // severity は「不具合の重さ」の尺度なので、要望に当てても意味を持たない。
    // 実測では要望に severity 1.94 が付き、優先度が跳ね上がっていた。
    for (const category of ['feature_request', 'improvement']) {
      const v = compose(answers({ category, severity: 2.9 }));
      expect(v.triageLevel).toBe('medium');
    }
  });

  it('質問と称賛は low', () => {
    expect(
      compose(answers({ category: 'question', severity: 2.9 })).triageLevel
    ).toBe('low');
    expect(
      compose(answers({ category: 'praise', severity: 2.9 })).triageLevel
    ).toBe('low');
  });
});

describe('component の確信度', () => {
  it('unknown のときは確信度を 0 にする', () => {
    // 公開リポジトリへの起票判定に使う値なので、絞り込めていないことを 0 で表す
    const v = compose(answers({ component: 'unknown', componentConf: 0.95 }));
    expect(v.componentConfidence).toBe(0);
  });

  it('component を特定できたときは分布由来の確信度をそのまま渡す', () => {
    const v = compose(
      answers({ component: 'station_api', componentConf: 0.83 })
    );
    expect(v.componentConfidence).toBeCloseTo(0.83);
  });
});

describe('needsSpamReview', () => {
  it('スパム確定には届かないがスパムらしさが残るときに立てる', () => {
    const v = compose(answers({ spam: 0.4 }));
    expect(v.isSpam).toBe(false);
    expect(v.needsSpamReview).toBe(true);
  });

  it('スパムらしさが十分低ければ立てない', () => {
    expect(compose(answers({ spam: 0.1 })).needsSpamReview).toBe(false);
  });

  it('スパム確定のときは立てない（確認するまでもない）', () => {
    const v = compose(answers({ spam: 0.9 }));
    expect(v.isSpam).toBe(true);
    expect(v.needsSpamReview).toBe(false);
  });
});

describe('spamSignal', () => {
  it('is_spam と is_announcement_transcript の大きい方を返す', () => {
    expect(compose(answers({ spam: 0.2, announcement: 0.4 })).spamSignal).toBe(
      0.4
    );
    expect(compose(answers({ spam: 0.6, announcement: 0.1 })).spamSignal).toBe(
      0.6
    );
  });
});
