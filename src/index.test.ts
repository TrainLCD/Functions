import {
  FEEDBACK_RETRY_DELAY_SECONDS,
  processFeedbackMessage,
} from './consumers/feedbackTriage';
import worker from './index';
import { GitHubIssueError } from './lib/githubIssueError';
import type { Env, FeedbackQueueMessage } from './types';

jest.mock('./consumers/feedbackTriage', () => ({
  FEEDBACK_RETRY_DELAY_SECONDS: 90,
  processFeedbackMessage: jest.fn(),
}));

it('GitHub のエラー詳細をログに残し、解除時刻まで再試行を遅らせる', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const ack = jest.fn();
  const retry = jest.fn();
  const batch = {
    queue: 'feedback-triage',
    messages: [
      { id: 'msg-1', body: { report: { id: 'report-1' } }, ack, retry },
    ],
  } as unknown as MessageBatch<FeedbackQueueMessage>;
  try {
    jest
      .mocked(processFeedbackMessage)
      .mockRejectedValueOnce(
        new GitHubIssueError(403, 'request-1', 3600, { errors: [] })
      );
    await worker.queue?.(batch, {} as Env, {} as ExecutionContext);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(spy).toHaveBeenCalledWith(
      'Queue message failed (feedback-triage):',
      expect.objectContaining({
        status: 403,
        errorMessage: 'GitHub API failed with status 403',
        reportId: 'report-1',
        requestId: 'request-1',
      })
    );
    jest
      .mocked(processFeedbackMessage)
      .mockRejectedValueOnce(new Error('network error'));
    await worker.queue?.(batch, {} as Env, {} as ExecutionContext);
    expect(retry).toHaveBeenLastCalledWith({
      delaySeconds: FEEDBACK_RETRY_DELAY_SECONDS,
    });
    jest.mocked(processFeedbackMessage).mockResolvedValueOnce(undefined);
    await worker.queue?.(batch, {} as Env, {} as ExecutionContext);
    expect(ack).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
