/**
 * runAgentTurn のテスト — LLM クライアント（streamText）をモックし、
 * ツール結果突合・件数切り詰め・空結果時の挙動を検証する（設計のテスト戦略）。
 * あわせて SSE ハンドラ（handleAgentChatStream）のイベント順序と払い戻しも検証する。
 */
import { classifyTopic } from './gate';
import {
  handleAgentChatStream,
  resolveDailyLimit,
  resolveSearchScope,
  runAgentTurn,
} from './handler';
import type { StationSuggestion } from './schema';
import { resolveAgentLLMRuntime } from './tracing';

jest.mock('../lib/auth/session', () => ({
  verifySessionToken: jest.fn().mockResolvedValue('install-1'),
}));
jest.mock('./gate', () => ({ classifyTopic: jest.fn() }));
jest.mock('./llm', () => ({
  ...jest.requireActual('./llm'),
  resolveAgentModel: () => 'mock-model',
}));
jest.mock('./prompt', () => ({
  loadAgentFaq: jest.fn().mockResolvedValue(null),
  buildSystemPrompt: () => 'SYSTEM',
  buildContextMessage: () => 'CONTEXT',
}));
jest.mock('./tracing', () => ({ resolveAgentLLMRuntime: jest.fn() }));

const station = (id: number, name = `駅${id}`): StationSuggestion => ({
  stationId: id,
  stationGroupId: id + 1000,
  name,
  nameRoman: `Sta${id}`,
  lineNames: ['JR線'],
});

// biome-ignore lint/suspicious/noExplicitAny: テスト用モックの型緩和
type AnyFn = any;

const baseParams = {
  model: 'mock-model' as AnyFn,
  systemPrompt: 'SYSTEM',
  contextNote: 'CONTEXT',
  messages: [{ role: 'user' as const, content: '海が見える駅に行きたい' }],
  locale: 'ja' as const,
};

/**
 * streamText の戻り値スタブ。runAgentTurn が使う
 * partialOutputStream / output / text だけを備える。
 */
const streamResult = ({
  partials = [],
  output,
  text = '',
}: {
  partials?: AnyFn[];
  output?: AnyFn;
  text?: string;
}): AnyFn => ({
  partialOutputStream: (async function* () {
    for (const partial of partials) {
      yield partial;
    }
  })(),
  // output が未指定なら「構造化出力を取り出せなかった」ケースを再現する
  get output() {
    return output === undefined
      ? Promise.reject(new Error('NoOutputGeneratedError'))
      : Promise.resolve(output);
  },
  text,
});

describe('resolveDailyLimit', () => {
  // 既定値 60 と区別するため、env のフォールバック値は 70 にする
  const env = { AGENT_DAILY_TURN_LIMIT: '70' } as AnyFn;

  it('config:remote の agent_daily_turn_limit を最優先する', () => {
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: 100 })).toBe(100);
    // 数値化できる文字列も許容し、小数は切り捨てる
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: '80' })).toBe(80);
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: 45.9 })).toBe(45);
  });

  it('未設定・不正値は env var へフォールバックする', () => {
    expect(resolveDailyLimit(env, {})).toBe(70);
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: 0 })).toBe(70);
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: -5 })).toBe(70);
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: 'abc' })).toBe(70);
    // 切り捨てで 0 になる小数を有効扱いすると全リクエスト拒否になるため不正値
    expect(resolveDailyLimit(env, { agent_daily_turn_limit: 0.5 })).toBe(70);
    expect(
      resolveDailyLimit(env, {
        agent_daily_turn_limit: Number.POSITIVE_INFINITY,
      })
    ).toBe(70);
  });

  it('env var も不正・欠損なら既定の 60 を使う', () => {
    expect(resolveDailyLimit({ AGENT_DAILY_TURN_LIMIT: '' } as AnyFn, {})).toBe(
      60
    );
    // Infinity は無制限化、負数は全拒否になるため既定値へフォールバック
    expect(
      resolveDailyLimit({ AGENT_DAILY_TURN_LIMIT: 'Infinity' } as AnyFn, {})
    ).toBe(60);
    expect(
      resolveDailyLimit({ AGENT_DAILY_TURN_LIMIT: '-10' } as AnyFn, {})
    ).toBe(60);
  });
});

describe('runAgentTurn', () => {
  it('ツールで実在確認済みの駅だけを返し、幻覚駅を破棄する', async () => {
    const searchStations = jest
      .fn()
      .mockResolvedValue([station(1, '鎌倉'), station(2, '逗子')]);
    const streamText: AnyFn = jest.fn(async (options: AnyFn) => {
      // モデルの代役としてツールを 1 回実行してから最終出力を返す
      await options.tools.search_stations_by_name.execute({ name: '海' }, {});
      return streamResult({
        output: {
          reply: '海の見える駅はこちらです。',
          suggestions: [
            { ...station(1), name: '改変された名前' },
            station(999, '実在しない駅'),
          ],
        },
      });
    });

    const result = await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations,
    });

    expect(result.refused).toBe(false);
    expect(result.reply).toBe('海の見える駅はこちらです。');
    expect(result.suggestions.map((s) => s.stationId)).toEqual([1]);
    // 内容は LLM 出力ではなく検証済みデータ
    expect(result.suggestions[0].name).toBe('鎌倉');
  });

  it('ツール結果が 0 件なら suggestions は必ず空配列になる', async () => {
    const streamText: AnyFn = jest.fn(async (options: AnyFn) => {
      await options.tools.search_stations_by_name.execute(
        { name: '桃源郷' },
        {}
      );
      return streamResult({
        output: {
          reply: '見つかりませんでした。',
          suggestions: [station(1), station(2)],
        },
      });
    });
    const result = await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations: jest.fn().mockResolvedValue([]),
    });
    expect(result.suggestions).toEqual([]);
    expect(result.reply).toBe('見つかりませんでした。');
  });

  it('現在駅ありの 0 件は「直通で行けないだけ」とモデルへ伝える', async () => {
    let notice: string | undefined;
    const streamText: AnyFn = jest.fn(async (options: AnyFn) => {
      const toolResult = await options.tools.search_stations_by_name.execute(
        { name: '江ノ島' },
        {}
      );
      notice = toolResult.notice;
      return streamResult({ output: { reply: 'ok', suggestions: [] } });
    });
    await runAgentTurn({
      ...baseParams,
      streamText,
      searchScope: 'reachable-from-known-station',
      searchStations: jest.fn().mockResolvedValue([]),
    });
    expect(notice).toContain('without a transfer');
  });

  it('現在駅の解決状況でスコープを分ける', () => {
    expect(resolveSearchScope(undefined, null)).toBe('nationwide');
    expect(resolveSearchScope(1130101, null)).toBe(
      'reachable-from-unknown-station'
    );
    expect(resolveSearchScope(1130101, station(1, '東京'))).toBe(
      'reachable-from-known-station'
    );
  });

  it('構造化出力の取り出しに失敗したらテキストへフォールバックする', async () => {
    const streamText: AnyFn = jest.fn(async () =>
      streamResult({ text: 'テキスト応答です。' })
    );
    const turn = await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations: jest.fn(),
    });
    expect(turn.reply).toBe('テキスト応答です。');
    expect(turn.suggestions).toEqual([]);
  });

  it('フォールバック時、JSON らしきテキストは partial 抽出済みの reply で救済する', async () => {
    const streamText: AnyFn = jest.fn(async () =>
      streamResult({
        partials: [{ reply: '海の見える駅' }],
        // 途中で切れた JSON（output の取り出しは失敗し、text はその生 JSON）
        text: '{"reply":"海の見える駅","suggestions":[',
      })
    );
    const turn = await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations: jest.fn(),
    });
    // 生の JSON をユーザに見せず、ストリーム済みの reply を確定応答にする
    expect(turn.reply).toBe('海の見える駅');
    expect(turn.suggestions).toEqual([]);
  });

  it('フォールバック時、JSON らしきテキストで reply も未抽出ならエラーを投げる', async () => {
    const streamText: AnyFn = jest.fn(async () =>
      streamResult({ text: '{"suggestions":[' })
    );
    await expect(
      runAgentTurn({ ...baseParams, streamText, searchStations: jest.fn() })
    ).rejects.toThrow('NoOutputGeneratedError');
  });

  it('構造化出力もテキストも取れなければエラーを投げる', async () => {
    const streamText: AnyFn = jest.fn(async () => streamResult({}));
    await expect(
      runAgentTurn({ ...baseParams, streamText, searchStations: jest.fn() })
    ).rejects.toThrow('NoOutputGeneratedError');
  });

  it('reply が空なら locale に応じたフォールバック文を返す', async () => {
    const streamText: AnyFn = jest.fn(async () =>
      streamResult({ output: { reply: '  ', suggestions: [] } })
    );
    const ja = await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations: jest.fn(),
    });
    expect(ja.reply).toContain('申し訳ありません');
    const en = await runAgentTurn({
      ...baseParams,
      locale: 'en',
      streamText,
      searchStations: jest.fn(),
    });
    expect(en.reply).toContain('Sorry');
  });

  it('partial の reply から増分だけを delta として送出する', async () => {
    const streamText: AnyFn = jest.fn(async (options: AnyFn) => {
      // ツール実行の合図はツール入力を伴わずに通知される
      await options.onChunk({ chunk: { type: 'tool-call' } });
      await options.onChunk({ chunk: { type: 'text-delta' } });
      return streamResult({
        partials: [
          { reply: '海の' },
          // partial JSON 由来で一時的に値が縮む・分岐するチャンクは送出しない
          { reply: '海' },
          { reply: '別の文字列' },
          { reply: '海の見える駅' },
          { suggestions: [] },
        ],
        output: { reply: '海の見える駅はこちらです。', suggestions: [] },
      });
    });
    const deltas: string[] = [];
    let toolStarts = 0;
    const result = await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations: jest.fn(),
      onDelta: (text) => {
        deltas.push(text);
      },
      onToolStart: () => {
        toolStarts += 1;
      },
    });
    expect(deltas).toEqual(['海の', '見える駅']);
    expect(toolStarts).toBe(1);
    // 取りこぼしは done の確定値で補正される
    expect(result.reply).toBe('海の見える駅はこちらです。');
  });

  it('システムプロンプトを先頭（キャッシュ境界付き）・可変コンテキストを次に置く', async () => {
    const streamText: AnyFn = jest.fn(async () =>
      streamResult({ output: { reply: 'ok', suggestions: [] } })
    );
    await runAgentTurn({
      ...baseParams,
      streamText,
      searchStations: jest.fn(),
    });

    const options = streamText.mock.calls[0][0];
    expect(options.messages[0]).toMatchObject({
      role: 'system',
      content: 'SYSTEM',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(options.messages[1]).toMatchObject({
      role: 'system',
      content: 'CONTEXT',
    });
    expect(options.messages[2]).toMatchObject({
      role: 'user',
      content: '海が見える駅に行きたい',
    });
    expect(options.maxRetries).toBe(0);
    expect(options.maxOutputTokens).toBe(1024);
    expect(options.timeout).toEqual({ stepMs: 20_000 });
  });

  it('Anthropic の thinking を無効化し、OpenAI の reasoning は対応モデルのみ抑制する', async () => {
    const streamText: AnyFn = jest.fn(async () =>
      streamResult({ output: { reply: 'ok', suggestions: [] } })
    );
    // 'none' 対応モデル（GPT-5.1 系）では reasoningEffort を指定する
    await runAgentTurn({
      ...baseParams,
      model: 'gpt-5.1' as AnyFn,
      streamText,
      searchStations: jest.fn(),
    });
    expect(streamText.mock.calls[0][0].providerOptions).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
      openai: { reasoningEffort: 'none' },
    });

    // 'none' 非対応モデル（gpt-5 無印・o 系など）へ送ると 400 になるため、
    // 対応が確認できないモデルでは指定自体を省略する
    await runAgentTurn({
      ...baseParams,
      model: 'gpt-5' as AnyFn,
      streamText,
      searchStations: jest.fn(),
    });
    expect(streamText.mock.calls[1][0].providerOptions).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
  });
});

describe('handleAgentChatStream', () => {
  /** レート制限カウンタだけを実体で持つ最小の Env（KV は結果整合の想定どおり読み書きする） */
  const createEnv = (): { env: AnyFn; counters: Map<string, string> } => {
    const counters = new Map<string, string>();
    return {
      env: {
        CONFIG_KV: {
          get: jest.fn().mockResolvedValue({ ai_agent_enabled: true }),
        },
        STATE_KV: {
          get: jest.fn(async (key: string) => counters.get(key) ?? null),
          put: jest.fn(async (key: string, value: string) => {
            counters.set(key, value);
          }),
        },
        AGENT_DAILY_TURN_LIMIT: '10',
      },
      counters,
    };
  };

  /** ctx.waitUntil に渡された処理（払い戻し・トレース送信）を待てるようにする */
  const createCtx = (): { ctx: AnyFn; pending: Promise<unknown>[] } => {
    const pending: Promise<unknown>[] = [];
    return {
      ctx: {
        waitUntil: (p: Promise<unknown>) => {
          pending.push(p);
        },
        passThroughOnException: () => {},
      },
      pending,
    };
  };

  const createRequest = (): Request =>
    new Request('https://example.com/agent/chat/stream', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          messages: [{ role: 'user', content: '海が見える駅に行きたい' }],
          locale: 'ja',
        },
      }),
    });

  /** SSE ボディを { event, data } の配列へ戻す */
  const readEvents = async (
    res: Response
  ): Promise<{ event: string; data: AnyFn }[]> => {
    const body = await res.text();
    return body
      .split('\n\n')
      .filter((block) => block.length > 0)
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        return {
          event: eventLine.slice('event: '.length),
          data: JSON.parse(dataLine.slice('data: '.length)),
        };
      });
  };

  /** マイクロタスク + タイマーキューを 1 巡させる（並列開始の確認用） */
  const flushAsync = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  const useRuntime = (streamText: AnyFn): void => {
    (resolveAgentLLMRuntime as AnyFn).mockReturnValue({
      streamText,
      flush: jest.fn().mockResolvedValue(undefined),
    });
  };

  /** フェーズ別レイテンシの計測ログ（1 行 JSON）を捕まえる */
  let logSpy: jest.SpyInstance;

  const readMetricsLog = (): AnyFn =>
    JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

  beforeEach(() => {
    (classifyTopic as AnyFn).mockResolvedValue('destination');
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('tool・delta を流してから done で確定応答を送る', async () => {
    useRuntime(
      jest.fn(async (options: AnyFn) => {
        await options.onChunk({ chunk: { type: 'tool-call' } });
        return streamResult({
          partials: [{ reply: '海の' }, { reply: '海の見える駅' }],
          output: { reply: '海の見える駅はこちらです。', suggestions: [] },
        });
      })
    );
    const { env } = createEnv();
    const { ctx, pending } = createCtx();

    const res = await handleAgentChatStream(createRequest(), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'text/event-stream; charset=UTF-8'
    );

    const events = await readEvents(res);
    await Promise.all(pending);
    expect(events.map((e) => e.event)).toEqual([
      'tool',
      'delta',
      'delta',
      'done',
    ]);
    expect(events[0].data).toEqual({});
    expect(events[1].data).toEqual({ text: '海の' });
    expect(events[2].data).toEqual({ text: '見える駅' });
    expect(events[3].data).toEqual({
      reply: '海の見える駅はこちらです。',
      suggestions: [],
      refused: false,
    });
  });

  it('本体ターンを開始したら持ち回数を消費する', async () => {
    useRuntime(
      jest.fn(async () =>
        streamResult({ output: { reply: 'ok', suggestions: [] } })
      )
    );
    const { env, counters } = createEnv();
    const { ctx, pending } = createCtx();

    const res = await handleAgentChatStream(createRequest(), env, ctx);
    await readEvents(res);
    await Promise.all(pending);

    expect([...counters.values()]).toEqual(['1']);
  });

  it('謝絶は delta なしで即 done を送り、持ち回数を消費しない', async () => {
    (classifyTopic as AnyFn).mockResolvedValue('off_topic');
    const streamText = jest.fn();
    useRuntime(streamText);
    const { env, counters } = createEnv();
    const { ctx, pending } = createCtx();

    const res = await handleAgentChatStream(createRequest(), env, ctx);
    const events = await readEvents(res);
    await Promise.all(pending);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('done');
    expect(events[0].data.refused).toBe(true);
    expect(events[0].data.suggestions).toEqual([]);
    // 本体 LLM は呼ばない
    expect(streamText).not.toHaveBeenCalled();
    // 消費前に確定するため、カウンタへの書き込み自体が発生しない（払い戻しも不要）
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
    expect(counters.size).toBe(0);
  });

  it('上限到達はストリーム開始前に callable エラーで返し、消費しない', async () => {
    useRuntime(jest.fn());
    const { env, counters } = createEnv();
    const { ctx } = createCtx();
    // AGENT_DAILY_TURN_LIMIT は 10。到達済みの状態を作る
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    counters.set(`agent-rl:install-1:${day}`, '10');

    // 期限超過（deadline-exceeded）へ誤変換されず、上限到達のまま返ること
    await expect(
      handleAgentChatStream(createRequest(), env, ctx)
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(env.STATE_KV.put).not.toHaveBeenCalled();
    // 応答を返さないリクエストの先行 I/O（Workers AI の分類など）は打ち切られる
    expect((classifyTopic as AnyFn).mock.calls[0][2].aborted).toBe(true);
  });

  it('キルスイッチ・上限チェック・トピックゲートを並列で開始する', async () => {
    useRuntime(
      jest.fn(async () =>
        streamResult({ output: { reply: 'ok', suggestions: [] } })
      )
    );
    const { env } = createEnv();
    let releaseConfig = (): void => {};
    env.CONFIG_KV.get.mockReturnValue(
      new Promise((resolve) => {
        releaseConfig = () => resolve({ ai_agent_enabled: true });
      })
    );
    const { ctx, pending } = createCtx();

    const resPromise = handleAgentChatStream(createRequest(), env, ctx);
    // 認証・入力パースの await を消化させる（並列前段の開始まで進める）
    await flushAsync();
    await flushAsync();

    // キルスイッチの KV 読み取りが未完了でも、上限チェックとゲートは走り出している
    expect(env.STATE_KV.get).toHaveBeenCalled();
    expect(classifyTopic).toHaveBeenCalled();

    releaseConfig();
    const res = await resPromise;
    await readEvents(res);
    await Promise.all(pending);
  });

  it('ターン終了時にフェーズ別レイテンシを 1 行の JSON で出す', async () => {
    useRuntime(
      jest.fn(async (options: AnyFn) => {
        await options.onChunk({ chunk: { type: 'tool-call' } });
        return streamResult({
          partials: [{ reply: '海の見える駅' }],
          output: { reply: '海の見える駅はこちらです。', suggestions: [] },
        });
      })
    );
    const { env } = createEnv();
    const { ctx, pending } = createCtx();

    const res = await handleAgentChatStream(createRequest(), env, ctx);
    await readEvents(res);
    await Promise.all(pending);

    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    const metrics = readMetricsLog();
    expect(metrics).toMatchObject({
      msg: 'agent.turn',
      mode: 'sse',
      outcome: 'done',
      toolCalls: 1,
    });
    for (const phase of [
      'authParse',
      'preflight',
      'gate',
      'context',
      'firstDelta',
      'total',
    ]) {
      expect(typeof metrics[phase]).toBe('number');
    }
    // 会話本文・駅名は一切含めない
    expect(line).not.toContain('海');
  });

  it('ストリーム開始後のエラーは error イベントで通知し、持ち回数を払い戻す', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    useRuntime(
      jest.fn(async () => {
        throw new Error('LLM exploded');
      })
    );
    const { env, counters } = createEnv();
    const { ctx, pending } = createCtx();

    const res = await handleAgentChatStream(createRequest(), env, ctx);
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    await Promise.all(pending);

    expect(events).toEqual([{ event: 'error', data: { code: 'internal' } }]);
    expect([...counters.values()]).toEqual(['0']);
    consoleError.mockRestore();
  });

  it('ストリーム開始前のエラーは SSE にせず callable エラーで返す', async () => {
    useRuntime(jest.fn());
    const { env } = createEnv();
    env.CONFIG_KV.get.mockResolvedValue({ ai_agent_enabled: false });
    const { ctx } = createCtx();

    await expect(
      handleAgentChatStream(createRequest(), env, ctx)
    ).rejects.toMatchObject({ code: 'unavailable' });
    // キルスイッチ発動時も先行 I/O は打ち切られる
    expect((classifyTopic as AnyFn).mock.calls[0][2].aborted).toBe(true);
  });
});
