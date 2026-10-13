/** Issue 作成失敗の診断情報。投稿本文や認証情報は保持しない。 */
export class GitHubIssueError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string | null,
    readonly retryDelaySeconds: number | null,
    readonly details: unknown
  ) {
    super(`GitHub API failed with status ${status}`);
    this.name = 'GitHubIssueError';
  }
}

export async function githubIssueError(
  response: Response,
  now = Date.now()
): Promise<GitHubIssueError> {
  // errors[].value / message は入力を含み得るため記録しない。
  const raw: unknown = await response.json().catch(() => null);
  const body = raw && typeof raw === 'object' ? raw : {};
  const errors =
    'errors' in body && Array.isArray(body.errors)
      ? body.errors.map((error: unknown) => {
          if (!error || typeof error !== 'object') return {};
          return Object.fromEntries(
            ['resource', 'field', 'code'].flatMap((key) => {
              const value = (error as Record<string, unknown>)[key];
              return typeof value === 'string'
                ? [[key, value.slice(0, 100)]]
                : [];
            })
          );
        })
      : [];
  const retryAfter = Number(response.headers.get('retry-after'));
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        retryAfter > 0 ||
        ('message' in body &&
          typeof body.message === 'string' &&
          /rate limit/i.test(body.message))));
  const delay = rateLimited
    ? Math.max(
        60,
        Number.isFinite(retryAfter) ? retryAfter : 0,
        response.headers.get('x-ratelimit-remaining') === '0' &&
          Number.isFinite(reset)
          ? reset - now / 1000
          : 0
      )
    : null;
  return new GitHubIssueError(
    response.status,
    response.headers.get('x-github-request-id'),
    delay === null ? null : Math.min(43200, Math.ceil(delay)),
    { errors }
  );
}
