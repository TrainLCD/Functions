/**
 * SSE エンコードと reply 差分抽出（純関数）のテスト。
 * 実際のストリーム配線は handler.test.ts の handleAgentChatStream で検証する。
 */
import { encodeAgentStreamEvent, extractReplyDelta } from './stream';

describe('encodeAgentStreamEvent', () => {
  it('event 行と data 行を組み立てて空行で終端する', () => {
    expect(
      encodeAgentStreamEvent({ event: 'delta', data: { text: 'こんにちは' } })
    ).toBe('event: delta\ndata: {"text":"こんにちは"}\n\n');
    expect(encodeAgentStreamEvent({ event: 'tool', data: {} })).toBe(
      'event: tool\ndata: {}\n\n'
    );
    expect(
      encodeAgentStreamEvent({ event: 'error', data: { code: 'internal' } })
    ).toBe('event: error\ndata: {"code":"internal"}\n\n');
  });

  it('done は非ストリーミングの result と同一形をそのまま載せる', () => {
    const encoded = encodeAgentStreamEvent({
      event: 'done',
      data: { reply: 'はい', suggestions: [], refused: false },
    });
    expect(encoded).toBe(
      'event: done\ndata: {"reply":"はい","suggestions":[],"refused":false}\n\n'
    );
  });

  it('本文に改行が含まれてもエスケープされ data 行は分割されない', () => {
    const encoded = encodeAgentStreamEvent({
      event: 'delta',
      data: { text: '1行目\n2行目' },
    });
    expect(encoded).toBe('event: delta\ndata: {"text":"1行目\\n2行目"}\n\n');
    // 終端の空行を除けば 2 行（event / data）に収まる
    expect(encoded.trimEnd().split('\n')).toHaveLength(2);
  });
});

describe('extractReplyDelta', () => {
  it('送出済みテキストからの増分だけを返す', () => {
    expect(extractReplyDelta('', '海の')).toBe('海の');
    expect(extractReplyDelta('海の', '海の見える駅')).toBe('見える駅');
    expect(extractReplyDelta('海の見える駅', '海の見える駅')).toBe('');
  });

  it('値が縮んだ・別の値へ分岐した partial では差分を出さない', () => {
    // partial JSON のパース途中で一時的に短くなるケース
    expect(extractReplyDelta('海の見える駅', '海の')).toBe('');
    // 直前までの本文と共通接頭辞を持たないケース
    expect(extractReplyDelta('海の', '山の')).toBe('');
  });

  it('reply が未確定（文字列でない）なら差分を出さない', () => {
    expect(extractReplyDelta('', undefined)).toBe('');
    expect(extractReplyDelta('海の', null)).toBe('');
    expect(extractReplyDelta('海の', 42)).toBe('');
  });
});
