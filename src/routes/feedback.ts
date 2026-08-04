/** POST /postFeedback — フィードバックを検証してトリアージキューへ投函する（callable 互換）。 */
import { verifySessionToken } from '../lib/auth/session';
import {
  CallableError,
  callableSuccess,
  parseCallableData,
} from '../lib/callable';
import type { Report } from '../models/feedback';
import type { Env } from '../types';

export const handleFeedback = async (
  req: Request,
  env: Env
): Promise<Response> => {
  const uid = await verifySessionToken(env, req.headers.get('Authorization'));

  const data = await parseCallableData<{ report?: Report }>(req);
  const report = data.report;
  if (!report?.id) {
    throw new CallableError('invalid-argument', 'report.id required');
  }

  // reporterUid はクライアント申告を信用せず、検証済みトークンの sub で上書きする。
  // （他ユーザーの UID を名乗って Issue/Discord に載せるなりすましを防ぐ）
  const verifiedReport: Report = { ...report, reporterUid: uid };

  // 重要: 生本文はログに出さない
  await env.FEEDBACK_QUEUE.send({
    id: verifiedReport.id,
    receivedAt: new Date().toISOString(),
    report: verifiedReport,
    version: 1,
  });

  return callableSuccess({ ok: true, queued: true, id: report.id });
};
