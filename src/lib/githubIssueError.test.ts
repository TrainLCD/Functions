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

  it.each([403, 429])(
    'HTTP %s の HTTP-date を再試行時刻として扱う',
    async (status) => {
      const now = Date.UTC(2026, 9, 14, 0, 0, 0, 500);
      const retryAt = new Date(now + 180_000).toUTCString();
      const error = await githubIssueError(
        response(status, { 'retry-after': retryAt }),
        now
      );
      // HTTP-date の秒精度で 179.5 秒先を示す。端数は切り上げる。
      expect(error.retryDelaySeconds).toBe(180);
    }
  );

  it('HTTP-date とレート制限解除時刻の遅い方まで待つ', async () => {
    const now = Date.UTC(2026, 9, 14);
    const error = await githubIssueError(
      response(403, {
        'retry-after': new Date(now + 180_000).toUTCString(),
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now / 1000 + 3600),
      }),
      now
    );
    expect(error.retryDelaySeconds).toBe(3600);
  });

  it.each(['invalid-date', '', 'Wed, 14 Oct 2026 00:00:00 GMT'])(
    '無効・空・過去の Retry-After (%s) は既定の待機時間を使う',
    async (retryAfter) => {
      const now = Date.UTC(2026, 9, 14, 1);
      const error = await githubIssueError(
        response(429, { 'retry-after': retryAfter }),
        now
      );
      expect(error.retryDelaySeconds).toBe(60);
    }
  );

  it('無効な Retry-After だけで権限エラーをレート制限にしない', async () => {
    const error = await githubIssueError(
      response(403, { 'retry-after': 'invalid-date' })
    );
    expect(error.retryDelaySeconds).toBeNull();
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
