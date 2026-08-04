import { CallableError } from '../lib/callable';
import type { StationSuggestion } from './schema';
import { parseChatRequest, sanitizeSuggestions } from './validate';

const userMessage = (content: string) => ({ role: 'user' as const, content });

describe('parseChatRequest', () => {
  it('正常なリクエストを受理する', () => {
    const req = parseChatRequest({
      messages: [userMessage('海が見える駅に行きたい')],
      locale: 'ja',
      currentStationGroupId: 1130205,
    });
    expect(req.messages).toHaveLength(1);
    expect(req.locale).toBe('ja');
    expect(req.currentStationGroupId).toBe(1130205);
  });

  it('locale が不正・未指定なら ja にフォールバックする', () => {
    expect(parseChatRequest({ messages: [userMessage('a')] }).locale).toBe(
      'ja'
    );
    expect(
      parseChatRequest({ messages: [userMessage('a')], locale: 'fr' }).locale
    ).toBe('ja');
  });

  it('メッセージ 13 件以上を拒否する', () => {
    const messages = Array.from({ length: 13 }, (_, i) =>
      i % 2 === 0
        ? userMessage(`m${i}`)
        : { role: 'assistant' as const, content: `m${i}` }
    );
    expect(() => parseChatRequest({ messages })).toThrow(CallableError);
  });

  it('501 文字のメッセージを拒否する', () => {
    expect(() =>
      parseChatRequest({ messages: [userMessage('あ'.repeat(501))] })
    ).toThrow(CallableError);
  });

  it('空メッセージ配列・不正 role・assistant 終わりの履歴を拒否する', () => {
    expect(() => parseChatRequest({ messages: [] })).toThrow(CallableError);
    expect(() =>
      parseChatRequest({ messages: [{ role: 'system', content: 'x' }] })
    ).toThrow(CallableError);
    expect(() =>
      parseChatRequest({
        messages: [userMessage('a'), { role: 'assistant', content: 'b' }],
      })
    ).toThrow(CallableError);
  });

  it('currentStationGroupId が不正なら拒否する', () => {
    expect(() =>
      parseChatRequest({
        messages: [userMessage('a')],
        currentStationGroupId: -1,
      })
    ).toThrow(CallableError);
  });
});

describe('sanitizeSuggestions', () => {
  const station = (id: number, name = `駅${id}`): StationSuggestion => ({
    stationId: id,
    stationGroupId: id,
    name,
    nameRoman: `Sta${id}`,
    lineNames: ['JR線'],
  });
  const verifiedOf = (...stations: StationSuggestion[]) =>
    new Map(stations.map((s) => [s.stationId, s]));

  it('ツール結果に含まれない駅を破棄する', () => {
    const verified = verifiedOf(station(1));
    const result = sanitizeSuggestions(
      [{ stationId: 1 }, { stationId: 999 }],
      verified
    );
    expect(result.map((s) => s.stationId)).toEqual([1]);
  });

  it('ツール結果が空なら必ず空配列を返す', () => {
    expect(sanitizeSuggestions([{ stationId: 1 }], new Map())).toEqual([]);
  });

  it('6 件以上は先頭 5 件に切り詰める', () => {
    const stations = [1, 2, 3, 4, 5, 6, 7].map((id) => station(id));
    const result = sanitizeSuggestions(
      stations.map((s) => ({ stationId: s.stationId })),
      verifiedOf(...stations)
    );
    expect(result).toHaveLength(5);
    expect(result.map((s) => s.stationId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stationId の重複を除去する', () => {
    const verified = verifiedOf(station(1), station(2));
    const result = sanitizeSuggestions(
      [{ stationId: 1 }, { stationId: 1 }, { stationId: 2 }],
      verified
    );
    expect(result.map((s) => s.stationId)).toEqual([1, 2]);
  });

  it('内容は LLM 出力ではなく検証済みデータで返す', () => {
    const verified = verifiedOf(station(1, '鎌倉'));
    const result = sanitizeSuggestions(
      [{ stationId: 1, name: '偽の駅名' } as { stationId: number }],
      verified
    );
    expect(result[0].name).toBe('鎌倉');
  });
});
