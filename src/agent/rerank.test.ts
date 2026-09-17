import {
  buildBatchedRequest,
  buildIsolatedRequests,
  buildRerankNote,
  type CandidateScore,
  createRerankSelector,
  judgeCandidates,
  MAX_JUDGED_CANDIDATES,
  questionId,
  type RerankInput,
  resolveRerankThreshold,
  selectSuggestions,
} from './rerank';
import type { StationSuggestion } from './schema';

const station = (id: number, name: string): StationSuggestion => ({
  stationId: id,
  stationGroupId: id,
  name,
  nameRoman: name,
  lineNames: ['テスト線'],
});

const input: RerankInput = {
  request: '海が見える駅に行きたい',
  currentStationName: '東京',
};

const options = {
  apiKey: 'key',
  model: 'jev-latest',
  shape: 'batched' as const,
};

const originalFetch = global.fetch;
const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const mockFetch = (handler: () => Response | Promise<Response>) => {
  const fetchMock = jest.fn(async () => handler());
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const noulAnswers = (values: number[]) =>
  Object.fromEntries(
    values.map((noul, index) => [questionId(index), { type: 'noul', noul }])
  );

describe('selectSuggestions', () => {
  const scores = (values: number[]): CandidateScore[] =>
    values.map((fits, index) => ({
      station: station(index, `駅${index}`),
      fits,
    }));

  it('確率の降順に並べる', () => {
    const picked = selectSuggestions(scores([0.3, 0.9, 0.6]), 0);
    expect(picked.map((s) => s.name)).toEqual(['駅1', '駅2', '駅0']);
  });

  it('閾値未満は落とす', () => {
    const picked = selectSuggestions(scores([0.8, 0.4, 0.75]), 0.7);
    expect(picked.map((s) => s.name)).toEqual(['駅0', '駅2']);
  });

  it('閾値と同値は残す', () => {
    expect(selectSuggestions(scores([0.7]), 0.7)).toHaveLength(1);
  });

  it('全候補が閾値未満なら空配列（「合う駅が無い」を表現できる）', () => {
    expect(selectSuggestions(scores([0.2, 0.1]), 0.7)).toEqual([]);
  });

  it('同じ確率なら判定に渡した順を保つ', () => {
    const picked = selectSuggestions(scores([0.5, 0.5, 0.5]), 0);
    expect(picked.map((s) => s.name)).toEqual(['駅0', '駅1', '駅2']);
  });

  it('上限件数で切り詰める', () => {
    const picked = selectSuggestions(scores([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]), 0);
    expect(picked).toHaveLength(5);
    expect(picked.map((s) => s.name)).toEqual([
      '駅0',
      '駅1',
      '駅2',
      '駅3',
      '駅4',
    ]);
  });

  // stationsByName は同一物理駅を路線別レコード（別 stationId・同一 groupId）で
  // 返す。畳まずに確率順で切ると枠が同じ駅で埋まる（実測で「海が見える駅」の
  // 上位5件が熱海4レコード＋真鶴になった）。
  describe('同一物理駅は groupId で 1 件に畳む', () => {
    /** 熱海の路線別 3 レコード（groupId 同じ）＋ 根府川・早川 */
    const atamiAndOthers: CandidateScore[] = [
      { station: { ...station(1, '熱海'), stationGroupId: 100 }, fits: 0.9 },
      { station: { ...station(2, '熱海'), stationGroupId: 100 }, fits: 0.89 },
      { station: { ...station(3, '熱海'), stationGroupId: 100 }, fits: 0.88 },
      { station: { ...station(4, '根府川'), stationGroupId: 200 }, fits: 0.8 },
      { station: { ...station(5, '早川'), stationGroupId: 300 }, fits: 0.7 },
    ];

    it('枠を同じ駅で埋めず、別の駅に回す', () => {
      const picked = selectSuggestions(atamiAndOthers, 0, 3);
      expect(picked.map((s) => s.name)).toEqual(['熱海', '根府川', '早川']);
    });

    it('残すのは同一グループで最も確率の高いレコード', () => {
      const picked = selectSuggestions(atamiAndOthers, 0, 1);
      expect(picked).toEqual([{ ...station(1, '熱海'), stationGroupId: 100 }]);
    });

    it('畳んだ結果が上限未満なら、その件数で返す', () => {
      const picked = selectSuggestions(atamiAndOthers.slice(0, 3), 0);
      expect(picked).toHaveLength(1);
    });
  });
});

describe('buildBatchedRequest', () => {
  it('候補数ぶんの質問を作り、state は 1 つにまとめる', () => {
    const { state, questions } = buildBatchedRequest(input, [
      station(1, '根府川'),
      station(2, '海老名'),
    ]);

    expect(state).toEqual({
      request: '海が見える駅に行きたい',
      current_station: '東京',
      candidates: [
        { name: '根府川', name_roman: '根府川', lines: ['テスト線'] },
        { name: '海老名', name_roman: '海老名', lines: ['テスト線'] },
      ],
    });
    expect(Object.keys(questions)).toEqual(['fits_0', 'fits_1']);
    expect(questions.fits_0.instructions).toContain('`candidates[0]`');
    expect(questions.fits_1.instructions).toContain('`candidates[1]`');
  });

  it('基準は全候補で同一にする（候補ごとに基準が変わると比較できない）', () => {
    const { questions } = buildBatchedRequest(input, [
      station(1, 'A'),
      station(2, 'B'),
    ]);
    expect(questions.fits_0.criteria).toEqual(questions.fits_1.criteria);
  });

  it('現在駅が不明なら state に載せない', () => {
    const { state } = buildBatchedRequest(
      { request: '温泉', currentStationName: null },
      [station(1, '鬼怒川温泉')]
    );
    expect(state).not.toHaveProperty('current_station');
  });
});

describe('buildIsolatedRequests', () => {
  it('候補ごとに 1 リクエストへ分け、各 state は 1 候補だけを載せる', () => {
    const requests = buildIsolatedRequests(input, [
      station(1, '根府川'),
      station(2, '海老名'),
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[0].state.candidate).toEqual({
      name: '根府川',
      name_roman: '根府川',
      lines: ['テスト線'],
    });
    expect(requests[0].state).not.toHaveProperty('candidates');
    expect(Object.keys(requests[0].questions)).toEqual(['fits']);
    expect(requests[0].questions.fits.instructions).toContain('`candidate`');
  });
});

describe('judgeCandidates', () => {
  it('候補が無ければ API を呼ばずに空配列を返す', async () => {
    const fetchMock = mockFetch(() => jsonResponse({}));
    await expect(judgeCandidates(input, [], options)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('案 Y は 1 リクエストで、回答を候補へ添字で戻す', async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ answers: noulAnswers([0.2, 0.95]) })
    );

    const scores = await judgeCandidates(
      input,
      [station(1, '海老名'), station(2, '根府川')],
      options
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(scores).toEqual([
      { station: station(1, '海老名'), fits: 0.2 },
      { station: station(2, '根府川'), fits: 0.95 },
    ]);
  });

  // 候補ごとに違う確率を返させ、送った state.candidate と戻ってきた station の
  // 対応まで固定する。全候補同じ値だと添字ズレの退行を検出できない。
  it('案 X は候補ごとにリクエストを出し、応答を送った候補に対応づける', async () => {
    const byName: Record<string, number> = { A: 0.1, B: 0.5, C: 0.9 };
    const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const name = body.state.candidate.name as string;
      return jsonResponse({
        answers: { fits: { type: 'noul', noul: byName[name] } },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const scores = await judgeCandidates(
      input,
      [station(1, 'A'), station(2, 'B'), station(3, 'C')],
      { ...options, shape: 'isolated' }
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(scores).toEqual([
      { station: station(1, 'A'), fits: 0.1 },
      { station: station(2, 'B'), fits: 0.5 },
      { station: station(3, 'C'), fits: 0.9 },
    ]);
  });

  // 判定できなかった候補を黙って落とすと、戻り値が「完全な判定結果」として扱われ、
  // その候補は閾値以上でも提案から確実に除外される。全候補を判定できたときだけ
  // 結果を返す。
  describe('1 件でも判定できなければ null を返す', () => {
    it('案 Y で一部の回答が型不一致・範囲外', async () => {
      mockFetch(() =>
        jsonResponse({
          answers: {
            fits_0: { type: 'noul', noul: 0.9 },
            fits_1: { type: 'choice', choice: 'yes' },
            fits_2: { type: 'noul', noul: 1.4 },
          },
        })
      );

      await expect(
        judgeCandidates(
          input,
          [station(1, 'A'), station(2, 'B'), station(3, 'C')],
          options
        )
      ).resolves.toBeNull();
    });

    it('案 Y で回答が 1 件も読めない（200 だが answers が空）', async () => {
      mockFetch(() => jsonResponse({ answers: {} }));

      await expect(
        judgeCandidates(input, [station(1, 'A'), station(2, 'B')], options)
      ).resolves.toBeNull();
    });

    it('案 X で一部のリクエストだけ失敗（429 の着順で提案が揺れないように）', async () => {
      let call = 0;
      mockFetch(() => {
        call += 1;
        return call === 1
          ? jsonResponse({}, 429)
          : jsonResponse({ answers: { fits: { type: 'noul', noul: 0.7 } } });
      });

      await expect(
        judgeCandidates(input, [station(1, 'A'), station(2, 'B')], {
          ...options,
          shape: 'isolated',
        })
      ).resolves.toBeNull();
    });
  });

  it('判定に渡す候補数には天井があり、送る質問も切り詰め後の数になる', async () => {
    const many = Array.from({ length: MAX_JUDGED_CANDIDATES + 10 }, (_, i) =>
      station(i, `駅${i}`)
    );
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        answers: noulAnswers(Array(MAX_JUDGED_CANDIDATES).fill(0.5)),
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const scores = await judgeCandidates(input, many, options);

    expect(scores).toHaveLength(MAX_JUDGED_CANDIDATES);
    // 戻り値の長さだけを見ると、切り詰め前の候補で質問を組む退行を見逃す
    // （モックが 30 問分しか答えないので scores は 30 のまま通ってしまう）
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string);
    expect(Object.keys(body.questions)).toHaveLength(MAX_JUDGED_CANDIDATES);
    expect(body.state.candidates).toHaveLength(MAX_JUDGED_CANDIDATES);
  });

  it('使用トークンを onUsage で返す', async () => {
    mockFetch(() =>
      jsonResponse({
        answers: noulAnswers([0.5]),
        usage: { input_tokens: 120, output_tokens: 3 },
      })
    );
    const onUsage = jest.fn();

    await judgeCandidates(input, [station(1, 'A')], { ...options, onUsage });

    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 3 });
  });

  // 失敗しても応答を壊さないのがこのモジュールの前提。例外を外に出さず null を返し、
  // 呼び出し側は LLM 側の順序に倒す。再試行もしない（待つ時間は本文に使うべき）。
  describe('失敗は握って null を返す', () => {
    it('HTTP エラー', async () => {
      const fetchMock = mockFetch(() => jsonResponse({}, 500));
      await expect(
        judgeCandidates(input, [station(1, 'A')], options)
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    });

    it('ネットワーク断', async () => {
      mockFetch(() => {
        throw new Error('network down');
      });
      await expect(
        judgeCandidates(input, [station(1, 'A')], options)
      ).resolves.toBeNull();
    });

    // SyntaxError.message は応答本文の先頭を含む（`Unexpected token 'o',
    // "SECRET" is not valid JSON`）。エラーをそのまま出すと、!res.ok 側で
    // 本文を出さないようにした意図がここで破れる。
    it('JSON が壊れている（本文をログに載せない）', async () => {
      mockFetch(() => new Response('SENSITIVE-BODY', { status: 200 }));

      await expect(
        judgeCandidates(input, [station(1, 'A')], options)
      ).resolves.toBeNull();

      const logged = warn.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('SyntaxError');
      expect(logged).not.toContain('SENSITIVE-BODY');
    });

    it('案 X で全候補が失敗した場合', async () => {
      mockFetch(() => jsonResponse({}, 503));
      await expect(
        judgeCandidates(input, [station(1, 'A'), station(2, 'B')], {
          ...options,
          shape: 'isolated',
        })
      ).resolves.toBeNull();
    });

    // 部分失敗（案 X の一部だけ 429 など）も null。
    // 「1 件でも判定できなければ null を返す」に集約してある。

    // 計測でコストを取り落とさないよう、null を返す経路でも使用トークンは報告する
    it('null を返す場合でも onUsage は呼ぶ', async () => {
      mockFetch(() =>
        jsonResponse({ answers: {}, usage: { input_tokens: 90 } })
      );
      const onUsage = jest.fn();

      await expect(
        judgeCandidates(input, [station(1, 'A')], { ...options, onUsage })
      ).resolves.toBeNull();
      expect(onUsage).toHaveBeenCalledWith({
        inputTokens: 90,
        outputTokens: 0,
      });
    });
  });

  it('signal を fetch へ渡す（ターン全体の期限で中断させる）', async () => {
    const controller = new AbortController();
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ answers: noulAnswers([0.5]) })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await judgeCandidates(input, [station(1, 'A')], {
      ...options,
      signal: controller.signal,
    });

    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });
});

describe('resolveRerankThreshold', () => {
  // 既定値をコードに持たない。KV に値が入るまでリランクは丸ごと無効
  it('未設定なら無効', () => {
    expect(resolveRerankThreshold({})).toBeNull();
  });

  it('0 より大きく 1 以下の数値だけ受ける', () => {
    expect(resolveRerankThreshold({ agent_rerank_threshold: 0.7 })).toBe(0.7);
    expect(resolveRerankThreshold({ agent_rerank_threshold: 1 })).toBe(1);
    expect(resolveRerankThreshold({ agent_rerank_threshold: 0 })).toBeNull();
    expect(resolveRerankThreshold({ agent_rerank_threshold: -0.1 })).toBeNull();
    expect(resolveRerankThreshold({ agent_rerank_threshold: 1.5 })).toBeNull();
  });

  it('数値でない値・非有限値は無効に倒す', () => {
    expect(resolveRerankThreshold({ agent_rerank_threshold: 'x' })).toBeNull();
    expect(resolveRerankThreshold({ agent_rerank_threshold: null })).toBeNull();
    expect(
      resolveRerankThreshold({
        agent_rerank_threshold: Number.POSITIVE_INFINITY,
      })
    ).toBeNull();
  });

  // KV は文字列で入ることがある（wrangler kv key put）
  it('数値として読める文字列は受ける', () => {
    expect(resolveRerankThreshold({ agent_rerank_threshold: '0.7' })).toBe(0.7);
  });
});

describe('buildRerankNote', () => {
  it('順序と路線名つきで並べ、集合外を禁じる', () => {
    const note = buildRerankNote([
      { ...station(1, '熱海'), lineNames: ['東海道線', '伊東線'] },
      station(2, '真鶴'),
    ]);
    expect(note).toContain('1. 熱海（東海道線・伊東線）');
    expect(note).toContain('2. 真鶴（テスト線）');
    expect(note).toContain('ここに無い駅を入れてはならない');
  });

  it('0 件なら「見つからなかった」と伝えるよう書く', () => {
    const note = buildRerankNote([]);
    expect(note).toContain('見つからなかった');
    expect(note).toContain('空配列');
    expect(note).toContain('埋め合わせに提案してはならない');
  });
});

describe('createRerankSelector', () => {
  it('判定して閾値で絞った駅を返す', async () => {
    mockFetch(() => jsonResponse({ answers: noulAnswers([0.9, 0.3]) }));
    const select = createRerankSelector({
      apiKey: 'key',
      model: 'jev-latest',
      threshold: 0.7,
    });

    await expect(
      select(input, [station(1, '熱海'), station(2, '来宮')])
    ).resolves.toEqual([station(1, '熱海')]);
  });

  it('判定できなければ null をそのまま返す（呼び出し側がフォールバックする）', async () => {
    mockFetch(() => jsonResponse({}, 500));
    const select = createRerankSelector({
      apiKey: 'key',
      model: 'jev-latest',
      threshold: 0.7,
    });

    await expect(select(input, [station(1, '熱海')])).resolves.toBeNull();
  });
});
