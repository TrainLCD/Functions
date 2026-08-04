import type { Env } from '../types';
import { buildGateUserPrompt, classifyTopic, parseGateResponse } from './gate';

describe('parseGateResponse', () => {
  it('オブジェクト応答から分類を取り出す', () => {
    expect(parseGateResponse({ classification: 'destination' })).toBe(
      'destination'
    );
    expect(parseGateResponse({ classification: 'app_usage' })).toBe(
      'app_usage'
    );
    expect(parseGateResponse({ classification: 'off_topic' })).toBe(
      'off_topic'
    );
  });

  it('JSON 文字列応答をパースする', () => {
    expect(parseGateResponse('{"classification": "off_topic"}')).toBe(
      'off_topic'
    );
  });

  it('ラベル単体の文字列も受け付ける', () => {
    expect(parseGateResponse('destination')).toBe('destination');
    expect(parseGateResponse('"app_usage"')).toBe('app_usage');
  });

  it('未知の値・壊れた応答は null を返す', () => {
    expect(parseGateResponse({ classification: 'banana' })).toBeNull();
    expect(parseGateResponse('こんにちは')).toBeNull();
    expect(parseGateResponse(null)).toBeNull();
    expect(parseGateResponse(undefined)).toBeNull();
    expect(parseGateResponse(42)).toBeNull();
  });
});

describe('buildGateUserPrompt', () => {
  it('直近 6 件だけを role 付きで連結する', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const prompt = buildGateUserPrompt(messages);
    expect(prompt).not.toContain('m0');
    expect(prompt).not.toContain('m1');
    expect(prompt).toContain('user: m2');
    expect(prompt).toContain('assistant: m7');
  });
});

describe('classifyTopic', () => {
  const makeEnv = (run: jest.Mock): Env =>
    ({ AI: { run }, AGENT_GATE_MODEL: '@cf/test-model' }) as unknown as Env;
  const messages = [
    { role: 'user' as const, content: '今日の晩ごはん何がいい？' },
  ];

  it('モデルの分類結果を返す', async () => {
    const run = jest
      .fn()
      .mockResolvedValue({ response: { classification: 'off_topic' } });
    await expect(classifyTopic(makeEnv(run), messages)).resolves.toBe(
      'off_topic'
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('パース不能な応答は destination に倒す', async () => {
    const run = jest.fn().mockResolvedValue({ response: '???' });
    await expect(classifyTopic(makeEnv(run), messages)).resolves.toBe(
      'destination'
    );
  });

  it('Workers AI の障害時は destination にフェイルオープンする', async () => {
    const run = jest.fn().mockRejectedValue(new Error('AI down'));
    await expect(classifyTopic(makeEnv(run), messages)).resolves.toBe(
      'destination'
    );
  });

  it('abort 済みシグナルではフェイルオープンせず即座に送出する', async () => {
    const run = jest.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      classifyTopic(makeEnv(run), messages, controller.signal)
    ).rejects.toThrow('aborted');
    expect(run).not.toHaveBeenCalled();
  });

  it('分類中に abort されたら destination に倒さず送出する', async () => {
    // 解決しない Promise で Workers AI のハングを再現する
    const run = jest.fn().mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const promise = classifyTopic(makeEnv(run), messages, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow('aborted');
  });
});
