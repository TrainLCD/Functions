import type { Env } from '../types';
import { CallableError } from './callable';

/** キュー受付前に、起票先へ認証できることを確認する。成功はキャッシュしない。 */
export async function ensureFeedbackAvailable(env: Env): Promise<void> {
  const unavailable = () =>
    new CallableError(
      'unavailable',
      'Feedback service is temporarily unavailable. Please try again later.'
    );
  if (!env.OCTOKIT_PAT?.trim()) {
    console.error('Feedback intake unavailable', {
      reason: 'OCTOKIT_PAT is not set',
    });
    throw unavailable();
  }
  let response: Response;
  try {
    // Issue 本文は取得せず、リポジトリへの認証・アクセスを検証する。
    response = await fetch('https://api.github.com/repos/TrainLCD/Issues', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.OCTOKIT_PAT}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'trainlcd-worker',
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.error('Feedback intake unavailable', {
      reason: 'GitHub request failed or timed out',
    });
    throw unavailable();
  }
  if (!response.ok) {
    console.error('Feedback intake unavailable', {
      status: response.status,
      requestId: response.headers.get('x-github-request-id'),
    });
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const raw: unknown = await response.json().catch(() => null);
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('has_issues' in raw) ||
    raw.has_issues !== true
  ) {
    console.error('Feedback intake unavailable', {
      reason: 'GitHub issue repository is unavailable',
    });
    throw unavailable();
  }
}
