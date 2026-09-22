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
    // 到達可能性による絞り込みは仕様。乗り換えが必要な駅も含むことを伝える
    expect(msg).toContain('鉄道で行ける駅だけを返す');
    expect(msg).toContain('乗り換えが必要な駅も含む');
    expect(msg).not.toContain('乗り換えなしで行ける駅だけ');
  });

  it('現在駅が未解決ならグループ ID のみへフォールバックする', () => {
    const msg = buildContextMessage('ja', null, 1130205);
    expect(msg).toContain('現在駅グループID: 1130205');
    expect(msg).toContain('鉄道で行ける駅だけを返す');
    expect(msg).toContain('乗り換えが必要な駅も含む');
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

  it('検索結果に乗り換えが必要な駅も含まれることを伝え 0 件で諦めさせない', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain('乗り換えれば行ける駅も含む');
    expect(prompt).toContain('0 件でもすぐ諦めない');
    expect(prompt).not.toContain('「現在駅から乗り換えなしで行ける駅」に');
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

  it('乗り換えが必要な駅も行き先として直接提案させ経路の詳細は断定させない', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain(
      '乗り換えが必要でもそのまま suggestions に含めてよい'
    );
    expect(prompt).toContain('ユーザが行きたい駅そのものを提案する');
    expect(prompt).toContain(
      '経由する路線・乗換駅・乗り換えの回数・\n  所要時間・運賃・直通運転の有無は、確認できないので断定しない'
    );
    // 直通の乗換地点だけを提案させていた旧手順は残さない
    expect(prompt).not.toContain('現在駅から直通で行ける乗換地点');
  });

  it('候補が見つからないときも最終目的に役立つ次の一手を案内させる', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain(
      '「目的地が存在しない」ではなく「現在駅から鉄道で行ける候補としては確認できない」と区別'
    );
    expect(prompt).toContain(
      'suggestions を空配列にし、ユーザが答えられる具体的な確認を 1 つだけ返す'
    );
    expect(prompt).toContain(
      '単に「見つかりませんでした」と言い換えて終えない'
    );
  });
});
