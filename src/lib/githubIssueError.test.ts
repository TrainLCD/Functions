import { githubIssueError } from './githubIssueError';

const response = (status: number, headers = {}, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('githubIssueError', () => {
  it('ステータスとリクエストIDを残し、検証エラーの投稿内容を除外する', async () => {
    const error = await githubIssueError(
      response(
        422,
        { 'x-github-request-id': 'request-1' },
        {
          message: 'private input',
          errors: [
            {
              resource: 'Issue',
              field: 'body',
              code: 'custom',
              value: 'private',
              message: 'private',
            },
          ],
        }
      )
    );
    expect(error.message).toBe('GitHub API failed with status 422');
    expect(error.requestId).toBe('request-1');
    expect(error.details).toEqual({
      errors: [{ resource: 'Issue', field: 'body', code: 'custom' }],
    });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(error.retryDelaySeconds).toBeNull();
  });

  it('レート制限解除時刻まで待つ', async () => {
    const error = await githubIssueError(
      response(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '4600',
        'retry-after': '120',
      }),
      1000_000
    );
    expect(error.retryDelaySeconds).toBe(3600);
  });

  it('secondary rate limit と Retry-After を扱う', async () => {
    expect(
      (
        await githubIssueError(
          response(403, {}, { message: 'secondary rate limit' })
        )
      ).retryDelaySeconds
    ).toBe(60);
    expect(
      (await githubIssueError(response(429, { 'retry-after': '180' })))
        .retryDelaySeconds
    ).toBe(180);
  });

  it('認証・権限エラーをレート制限として扱わない', async () => {
    for (const status of [401, 403, 404, 500]) {
      expect(
        (await githubIssueError(response(status))).retryDelaySeconds
      ).toBeNull();
    }
  });

  it('JSONでない障害応答でもステータスを失わない', async () => {
    const error = await githubIssueError(
      new Response('Bad Gateway', { status: 502 })
    );
    expect(error.status).toBe(502);
    expect(error.details).toEqual({ errors: [] });
  });
});
