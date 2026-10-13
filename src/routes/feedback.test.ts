import { CallableError, withCallable } from '../lib/callable';
import type { Env } from '../types';
import { handleFeedback } from './feedback';

jest.mock('../lib/auth/session', () => ({
  verifySessionToken: jest.fn(async () => 'verified-uid'),
}));

const send = jest.fn(async (_message: unknown) => undefined);
const env = {
  OCTOKIT_PAT: 'test-pat',
  FEEDBACK_QUEUE: { send },
} as unknown as Env;

const buildRequest = (report: unknown): Request =>
  new Request('https://example.com/postFeedback', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      Authorization: 'Bearer dummy',
    },
    body: JSON.stringify({ data: { report } }),
  });

const baseReport = {
  id: 'feedback-id',
  reportType: 'feedback',
  description: '遅い',
  reporterUid: 'client-claimed-uid',
};

describe('handleFeedback', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ has_issues: true, permissions: { push: true } })
        )
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it.each([401, 403, 404, 429, 500])(
    'returns an app-visible 503 for GitHub HTTP %s without queueing',
    async (status) => {
      global.fetch = jest.fn(
        async () => new Response(null, { status })
      ) as typeof fetch;
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await withCallable(() =>
          handleFeedback(buildRequest(baseReport), env)
        );
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          error: { status: 'unavailable' },
        });
        expect(send).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('returns 503 on a missing PAT or network failure without queueing', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const missing = await withCallable(() =>
        handleFeedback(buildRequest(baseReport), { ...env, OCTOKIT_PAT: '' })
      );
      expect(missing.status).toBe(503);
      expect(global.fetch).not.toHaveBeenCalled();
      global.fetch = jest.fn().mockRejectedValue(new Error('network failure'));
      const failed = await withCallable(() =>
        handleFeedback(buildRequest(baseReport), env)
      );
      expect(failed.status).toBe(503);
      expect(send).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([null, { has_issues: false }])(
    'rejects an unavailable issue repository',
    async (body) => {
      global.fetch = jest.fn(
        async () => new Response(JSON.stringify(body))
      ) as typeof fetch;
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await withCallable(() =>
          handleFeedback(buildRequest(baseReport), env)
        );
        expect(res.status).toBe(503);
        expect(send).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  );

  // 文字数の下限は撤廃したため、短い本文もそのままキューへ流す
  it('queues a short report', async () => {
    const res = await handleFeedback(buildRequest(baseReport), env);

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      id: 'feedback-id',
      report: { description: '遅い', reporterUid: 'verified-uid' },
    });
  });

  // code は HTTP ステータスへ直結する（invalid-argument なら 400）。CallableError で
  // あることしか見ていないと、internal へ変わって 500 を返すようになっても気づけない。
  // アプリは 4xx と 5xx で扱いを変えられるため、コードまで固定する。
  it.each([
    ['empty', ''],
    ['whitespace only', '  \n\t '],
    ['number', 1],
    ['null', null],
  ])(
    'rejects a %s description without queueing',
    async (_label, description) => {
      const rejected = handleFeedback(
        buildRequest({ ...baseReport, description }),
        env
      );

      await expect(rejected).rejects.toThrow(CallableError);
      await expect(rejected).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('rejects a missing description without queueing', async () => {
    const rejected = handleFeedback(buildRequest({ id: 'feedback-id' }), env);

    await expect(rejected).rejects.toThrow(/report.description required/);
    await expect(rejected).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(send).not.toHaveBeenCalled();
  });
});
