import { buildContextMessage, buildSystemPrompt } from './prompt';

describe('buildContextMessage', () => {
  it('現在駅が解決済みなら駅名・路線と相対表現の解釈指示を含める', () => {
    const msg = buildContextMessage('ja', {
      stationId: 1,
      stationGroupId: 1130205,
      name: '西船橋',
      nameRoman: 'Nishi-Funabashi',
      lineNames: ['JR総武線', '東京メトロ東西線'],
    });
    expect(msg).toContain('現在駅: 西船橋駅（Nishi-Funabashi）');
    expect(msg).toContain('JR総武線・東京メトロ東西線');
    expect(msg).toContain('「ここ」');
    // 到達可能性による絞り込みは仕様。0 件を「存在しない」と誤解させない
    expect(msg).toContain('乗り換えなしで行ける駅だけを返す');
  });

  it('現在駅が未解決ならグループ ID のみへフォールバックする', () => {
    const msg = buildContextMessage('ja', null, 1130205);
    expect(msg).toContain('現在駅グループID: 1130205');
    expect(msg).toContain('乗り換えなしで行ける駅だけを返す');
    expect(msg).not.toContain('「ここ」');
  });

  it('現在駅情報が一切無ければ locale 行のみ', () => {
    const msg = buildContextMessage('en');
    expect(msg).toBe(
      'locale: en（会話から入力言語を判別できないときの既定言語。Respond in English）'
    );
  });

  // locale は端末の言語設定であり、応答言語そのものの指示ではない
  it('locale 行は入力言語を判別できないときの既定であることを明示する', () => {
    expect(buildContextMessage('ja')).toContain('既定言語');
  });
});

describe('buildSystemPrompt', () => {
  it('英語会話でも日本語表記で検索させる指示を含む', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain('日本語表記（漢字・かな）を第一候補にする');
    expect(prompt).toContain('Kinugawa-onsen');
  });

  it('0 件で諦めず直通で行ける沿線から引き直す指示を含む', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain('乗り換えなしで行ける駅');
    expect(prompt).toContain('直通で行ける範囲に代替候補がないか確認する');
  });

  // 端末が英語設定でも日本語で聞かれたら日本語で返す（locale 追従をやめた経緯）
  it('応答言語を直近のユーザ発話に合わせる指示を含む', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain('reply は直近のユーザ発話と同じ言語で書く');
    // 直近が判別不能なときは前ターンへ、それも無ければ locale へ、の 2 段階
    expect(prompt).toContain('それより前のユーザ発話の言語に合わせる');
    expect(prompt).toContain('会話全体で判別できなければ locale の既定言語');
    expect(prompt).not.toContain(
      '応答言語は会話に添えられた locale 指示に従う'
    );
  });

  it('直通候補が無いときも最終目的に役立つ次の一手を案内させる', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain(
      '「目的地へ行けない」ではなく「現在駅から直通の候補としては確認できない」と区別'
    );
    expect(prompt).toContain(
      '最終目的地への接続まで確認できる情報がある場合に限り'
    );
    expect(prompt).toContain(
      'search_stations_by_name の結果は現在駅からの直通到達性しか保証しない'
    );
    expect(prompt).toContain(
      'それだけを根拠に駅を乗換地点として扱わない'
    );
    expect(prompt).toContain(
      '最終目的地への接続を確認できない場合は suggestions を空配列'
    );
    expect(prompt).toContain(
      '単に「乗り換えが必要です」「見つかりませんでした」と言い換えて終えない'
    );
  });
});
