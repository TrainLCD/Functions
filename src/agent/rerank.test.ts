import {
  buildBatchedRequest,
  buildIsolatedRequests,
  type CandidateScore,
  judgeCandidates,
  MAX_JUDGED_CANDIDATES,
  questionId,
  type RerankInput,
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

  it('案 X は候補ごとにリクエストを出す', async () => {
    const fetchMock = mockFetch(() =>
      jsonResponse({ answers: { fits: { type: 'noul', noul: 0.8 } } })
    );

    const scores = await judgeCandidates(
      input,
      [station(1, 'A'), station(2, 'B'), station(3, 'C')],
      { ...options, shape: 'isolated' }
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(scores?.map((s) => s.fits)).toEqual([0.8, 0.8, 0.8]);
  });

  it('形の合わない回答はその候補だけ落とす', async () => {
    mockFetch(() =>
      jsonResponse({
        answers: {
          fits_0: { type: 'noul', noul: 0.9 },
          fits_1: { type: 'choice', choice: 'yes' },
          fits_2: { type: 'noul', noul: 1.4 },
        },
      })
    );

    const scores = await judgeCandidates(
      input,
      [station(1, 'A'), station(2, 'B'), station(3, 'C')],
      options
    );

    expect(scores).toEqual([{ station: station(1, 'A'), fits: 0.9 }]);
  });

  it('判定に渡す候補数には天井がある', async () => {
    const many = Array.from({ length: MAX_JUDGED_CANDIDATES + 10 }, (_, i) =>
      station(i, `駅${i}`)
    );
    mockFetch(() =>
      jsonResponse({
        answers: noulAnswers(Array(MAX_JUDGED_CANDIDATES).fill(0.5)),
      })
    );

    const scores = await judgeCandidates(input, many, options);
    expect(scores).toHaveLength(MAX_JUDGED_CANDIDATES);
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

    it('JSON が壊れている', async () => {
      mockFetch(() => new Response('not json', { status: 200 }));
      await expect(
        judgeCandidates(input, [station(1, 'A')], options)
      ).resolves.toBeNull();
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

    it('案 X で一部だけ失敗した場合は成功分を返す', async () => {
      let call = 0;
      mockFetch(() => {
        call += 1;
        return call === 1
          ? jsonResponse({}, 503)
          : jsonResponse({ answers: { fits: { type: 'noul', noul: 0.7 } } });
      });

      const scores = await judgeCandidates(
        input,
        [station(1, 'A'), station(2, 'B')],
        { ...options, shape: 'isolated' }
      );

      expect(scores).toEqual([{ station: station(2, 'B'), fits: 0.7 }]);
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
