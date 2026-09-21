import { CallableError } from '../lib/callable';
import type { Env } from '../types';
import { handleFeedback } from './feedback';

jest.mock('../lib/auth/session', () => ({
  verifySessionToken: jest.fn(async () => 'verified-uid'),
}));

const send = jest.fn(async (_message: unknown) => undefined);
const env = { FEEDBACK_QUEUE: { send } } as unknown as Env;

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
  afterEach(() => {
    jest.clearAllMocks();
  });

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

  it.each([
    ['empty', ''],
    ['whitespace only', '  \n\t '],
  ])(
    'rejects a %s description without queueing',
    async (_label, description) => {
      await expect(
        handleFeedback(buildRequest({ ...baseReport, description }), env)
      ).rejects.toThrow(CallableError);
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('rejects a missing description without queueing', async () => {
    await expect(
      handleFeedback(buildRequest({ id: 'feedback-id' }), env)
    ).rejects.toThrow(/report.description required/);
    expect(send).not.toHaveBeenCalled();
  });
});
