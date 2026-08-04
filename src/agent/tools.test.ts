import type { Env } from '../types';
import type { StationSuggestion } from './schema';
import {
  buildStationNameVariants,
  createStationSearchTool,
  fetchStationByGroupId,
  MAX_TOOL_CALLS_PER_TURN,
  searchStationsByName,
  toStationSuggestion,
} from './tools';

const gqlStation = (id: number, name = `駅${id}`) => ({
  id,
  groupId: id + 1000,
  name,
  nameRoman: `Sta${id}`,
  lines: [{ nameShort: 'JR横須賀線' }, { nameShort: null }],
});

const gqlResponse = (stations: unknown[]) =>
  new Response(JSON.stringify({ data: { stationsByName: stations } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('toStationSuggestion', () => {
  it('GraphQL の Station を軽量スキーマへ詰め替える（groupId → stationGroupId）', () => {
    expect(toStationSuggestion(gqlStation(1, '鎌倉'))).toEqual({
      stationId: 1,
      stationGroupId: 1001,
      name: '鎌倉',
      nameRoman: 'Sta1',
      lineNames: ['JR横須賀線'],
    });
  });

  it('必須フィールド欠落は null を返す', () => {
    expect(toStationSuggestion({ id: 1, groupId: null, name: 'x' })).toBeNull();
    expect(toStationSuggestion({ id: 1, groupId: 2, name: null })).toBeNull();
  });

  it('nameRoman 欠落は空文字にフォールバックする', () => {
    const s = toStationSuggestion({
      id: 1,
      groupId: 2,
      name: 'x',
      nameRoman: null,
    });
    expect(s?.nameRoman).toBe('');
  });
});

describe('buildStationNameVariants', () => {
  it('区切りの無い日本語駅名は候補 1 件のまま（余計な検索を増やさない）', () => {
    expect(buildStationNameVariants('鎌倉高校前')).toEqual(['鎌倉高校前']);
  });

  it('「駅」「Station」などの接尾辞は落とすが、入力そのままを先に試す', () => {
    // 「広島駅（Hiroshima Station）」「富山駅（Toyama Sta.）」のように
    // 接尾辞に見える文字列が駅名そのものの実在駅があるため、順序が重要
    expect(buildStationNameVariants('鎌倉駅')).toEqual(['鎌倉駅', '鎌倉']);
    expect(buildStationNameVariants('Hiroshima Station')).toEqual([
      'Hiroshima Station',
      'Hiroshima',
    ]);
    expect(buildStationNameVariants('Toyama Sta.')).toEqual([
      'Toyama Sta.',
      'Toyama',
    ]);
    expect(buildStationNameVariants('Fukui-Eki')).toEqual([
      'Fukui-Eki',
      'Fukui',
    ]);
  });

  it('区切りの無い語尾は接尾辞として削らない（実在駅名を壊さない）', () => {
    // "Seki" → "S"、"Ichinoseki" → "Ichinos" のような破壊を防ぐ
    expect(buildStationNameVariants('Seki')).toEqual(['Seki']);
    expect(buildStationNameVariants('Ichinoseki')).toEqual(['Ichinoseki']);
    expect(buildStationNameVariants('Kosta')).toEqual(['Kosta']);
  });

  it('分かち書きローマ字はハイフン連結と最長トークンへフォールバックする', () => {
    expect(buildStationNameVariants('Kinugawa Onsen')).toEqual([
      'Kinugawa Onsen',
      'Kinugawa-Onsen',
      'Kinugawa',
    ]);
    expect(buildStationNameVariants('Katase Enoshima')).toEqual([
      'Katase Enoshima',
      'Katase-Enoshima',
      'Enoshima',
    ]);
  });

  it('空白入りの日本語は空白除去へフォールバックする', () => {
    expect(buildStationNameVariants('鎌倉 高校前')).toEqual([
      '鎌倉 高校前',
      '鎌倉高校前',
      '高校前',
    ]);
  });

  it('ハイフン区切りのローマ字は最長トークンを予備候補にする', () => {
    expect(buildStationNameVariants('Kamakura-koko-mae')).toEqual([
      'Kamakura-koko-mae',
      'Kamakura',
    ]);
  });

  it('空文字は候補なし', () => {
    expect(buildStationNameVariants('   ')).toEqual([]);
  });
});

describe('searchStationsByName', () => {
  const makeEnv = (fetchImpl: jest.Mock): Env =>
    ({ SAPI_BFF: { fetch: fetchImpl } }) as unknown as Env;

  const queriedNames = (fetchMock: jest.Mock): string[] =>
    fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body).variables.name
    );

  it('Service Binding 経由で検索し結果をマップする', async () => {
    const fetchMock = jest.fn().mockResolvedValue(gqlResponse([gqlStation(1)]));
    const result = await searchStationsByName(
      makeEnv(fetchMock),
      '鎌倉',
      1130205
    );
    expect(result).toHaveLength(1);
    expect(result[0].stationId).toBe(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.variables).toEqual({
      name: '鎌倉',
      limit: 10,
      fromStationGroupId: 1130205,
    });
  });

  it('失敗時に 1 回だけ再試行する', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(gqlResponse([gqlStation(2)]));
    const result = await searchStationsByName(
      makeEnv(fetchMock),
      '海',
      undefined
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result[0].stationId).toBe(2);
  });

  it('2 回失敗したらエラーを送出する', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(
      searchStationsByName(makeEnv(fetchMock), '海', undefined)
    ).rejects.toThrow('status 500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('GraphQL errors はエラー扱いにする', async () => {
    // 再試行でボディが 2 回読まれるため、呼び出しごとに新しい Response を返す
    const fetchMock = jest.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
          status: 200,
        })
      )
    );
    await expect(
      searchStationsByName(makeEnv(fetchMock), '海', undefined)
    ).rejects.toThrow('boom');
  });

  it('バインディングも URL も無ければエラー', async () => {
    await expect(
      searchStationsByName({} as unknown as Env, '海', undefined)
    ).rejects.toThrow('SAPI_BFF');
  });

  it('0 件なら表記ゆれ候補で引き直す（分かち書きローマ字の救済）', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(gqlResponse([]))
      .mockResolvedValueOnce(gqlResponse([gqlStation(3, '鬼怒川温泉')]));
    const result = await searchStationsByName(
      makeEnv(fetchMock),
      'Kinugawa Onsen',
      undefined
    );
    expect(queriedNames(fetchMock)).toEqual([
      'Kinugawa Onsen',
      'Kinugawa-Onsen',
    ]);
    expect(result[0].name).toBe('鬼怒川温泉');
  });

  it('全候補が 0 件なら空配列を返す（呼び出しは上限まで）', async () => {
    // 候補ごとにボディが読まれるため、呼び出しごとに新しい Response を返す
    const fetchMock = jest
      .fn()
      .mockImplementation(() => Promise.resolve(gqlResponse([])));
    const result = await searchStationsByName(
      makeEnv(fetchMock),
      'Katase Enoshima',
      undefined
    );
    expect(result).toEqual([]);
    expect(queriedNames(fetchMock)).toEqual([
      'Katase Enoshima',
      'Katase-Enoshima',
      'Enoshima',
    ]);
  });

  it('候補を試しても合計呼び出し回数は上限を超えない', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(
      searchStationsByName(makeEnv(fetchMock), 'Kinugawa Onsen', undefined)
    ).rejects.toThrow('status 500');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('先行候補がエラーでも後続候補がヒットすれば結果を返す', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(gqlResponse([gqlStation(4, '鬼怒川温泉')]));
    const result = await searchStationsByName(
      makeEnv(fetchMock),
      'Kinugawa Onsen',
      undefined
    );
    expect(result[0].name).toBe('鬼怒川温泉');
  });

  it('abort 済みの親シグナルは fetch へ即座に伝播する', async () => {
    const fetchMock = jest.fn().mockResolvedValue(gqlResponse([]));
    const controller = new AbortController();
    controller.abort();
    await searchStationsByName(
      makeEnv(fetchMock),
      '海',
      undefined,
      controller.signal
    ).catch(() => {});
    const [, init] = fetchMock.mock.calls[0];
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });
});

describe('fetchStationByGroupId', () => {
  const makeEnv = (fetchImpl: jest.Mock): Env =>
    ({ SAPI_BFF: { fetch: fetchImpl } }) as unknown as Env;

  const groupResponse = (stations: unknown[]) =>
    new Response(JSON.stringify({ data: { stationGroupStations: stations } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('グループ内の駅を 1 件へ集約し路線名を統合する', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      groupResponse([
        { ...gqlStation(1, '西船橋'), lines: [{ nameShort: 'JR総武線' }] },
        {
          ...gqlStation(2, '西船橋'),
          lines: [{ nameShort: '東京メトロ東西線' }],
        },
        { ...gqlStation(3, '西船橋'), lines: [{ nameShort: 'JR総武線' }] },
      ])
    );
    const station = await fetchStationByGroupId(makeEnv(fetchMock), 1130205);
    expect(station?.name).toBe('西船橋');
    expect(station?.lineNames).toEqual(['JR総武線', '東京メトロ東西線']);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).variables).toEqual({ groupId: 1130205 });
  });

  it('該当駅が無ければ null を返す', async () => {
    const fetchMock = jest.fn().mockResolvedValue(groupResponse([]));
    await expect(
      fetchStationByGroupId(makeEnv(fetchMock), 999)
    ).resolves.toBeNull();
  });

  it('失敗時に 1 回だけ再試行する', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(groupResponse([gqlStation(1, '鎌倉')]));
    const station = await fetchStationByGroupId(makeEnv(fetchMock), 1130205);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(station?.name).toBe('鎌倉');
  });

  it('2 回失敗したらエラーを送出する', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(
      fetchStationByGroupId(makeEnv(fetchMock), 1130205)
    ).rejects.toThrow('status 500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createStationSearchTool', () => {
  const execute = async (
    t: ReturnType<typeof createStationSearchTool>,
    name: string
  ): Promise<{ stations: StationSuggestion[]; notice?: string }> =>
    // biome-ignore lint/suspicious/noExplicitAny: テストではツール実行オプションを省略する
    (t as any).execute({ name }, {});

  it('検索結果を verified マップへ蓄積する', async () => {
    const verified = new Map<number, StationSuggestion>();
    const station: StationSuggestion = {
      stationId: 1,
      stationGroupId: 1001,
      name: '鎌倉',
      nameRoman: 'Kamakura',
      lineNames: ['JR横須賀線'],
    };
    const tool = createStationSearchTool({
      search: jest.fn().mockResolvedValue([station]),
      verified,
      budget: { remaining: MAX_TOOL_CALLS_PER_TURN },
    });
    const result = await execute(tool, '鎌倉');
    expect(result.stations).toEqual([station]);
    expect(verified.get(1)).toEqual(station);
  });

  it('呼び出し上限を超えたら検索せず空を返す', async () => {
    const search = jest.fn();
    const tool = createStationSearchTool({
      search,
      verified: new Map(),
      budget: { remaining: 0 },
    });
    const result = await execute(tool, '鎌倉');
    expect(search).not.toHaveBeenCalled();
    expect(result.stations).toEqual([]);
    expect(result.notice).toContain('limit');
  });

  it('0 件のときは引き直し方を notice で示す', async () => {
    const tool = createStationSearchTool({
      search: jest.fn().mockResolvedValue([]),
      verified: new Map(),
      budget: { remaining: 1 },
    });
    const result = await execute(tool, 'Kamakura Kokomae');
    expect(result.stations).toEqual([]);
    expect(result.notice).toContain('Japanese name');
    // 現在駅が無いときは到達可能性の話をしない（誤ったヒントを与えない）
    expect(result.notice).not.toContain('reachable');
  });

  it('現在駅ありの 0 件は「直通で行けないだけ」と伝える', async () => {
    const tool = createStationSearchTool({
      search: jest.fn().mockResolvedValue([]),
      verified: new Map(),
      budget: { remaining: 1 },
      scope: 'reachable-from-known-station',
    });
    const result = await execute(tool, '江ノ島');
    expect(result.stations).toEqual([]);
    expect(result.notice).toContain('without a transfer');
    expect(result.notice).toContain('does NOT mean it does not exist');
    // 乗入路線はコンテキストで渡っているので沿線での引き直しを促せる
    expect(result.notice).toContain("current station's own lines");
  });

  it('現在駅が未解決なら沿線での引き直しではなくユーザへの確認を促す', async () => {
    const tool = createStationSearchTool({
      search: jest.fn().mockResolvedValue([]),
      verified: new Map(),
      budget: { remaining: 1 },
      scope: 'reachable-from-unknown-station',
    });
    const result = await execute(tool, '江ノ島');
    expect(result.notice).toContain('without a transfer');
    // 路線名を知らないモデルに沿線検索を指示しない
    expect(result.notice).not.toContain("current station's own lines");
    expect(result.notice).toContain('ask the user which area or line');
  });

  it('スコープに応じてツール説明の到達可能性の記述を出し分ける', () => {
    const describe_ = (
      scope?: Parameters<typeof createStationSearchTool>[0]['scope']
    ) =>
      createStationSearchTool({
        search: jest.fn(),
        verified: new Map(),
        budget: { remaining: 1 },
        scope,
      }).description ?? '';

    expect(describe_('reachable-from-known-station')).toContain(
      '現在駅の乗入路線・直通先の沿線にある別の駅で引き直すこと'
    );
    expect(describe_('reachable-from-unknown-station')).toContain(
      'ユーザにどのエリア・路線にいるかを尋ねること'
    );
    expect(describe_()).not.toContain('乗り換えなし');
  });

  it('検索失敗はエラーにせずツール結果として返す', async () => {
    const tool = createStationSearchTool({
      search: jest.fn().mockRejectedValue(new Error('down')),
      verified: new Map(),
      budget: { remaining: 1 },
    });
    const result = await execute(tool, '鎌倉');
    expect(result.stations).toEqual([]);
    expect(result.notice).toContain('failed');
  });
});
