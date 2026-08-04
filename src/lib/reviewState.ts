/** レビュー通知ジョブの既読状態を KV で保持する（旧 GCS state の代替）。 */
export type ReviewState = {
  lastUpdated?: string | null;
  lastIds?: string[];
};

export const loadReviewState = async (
  kv: KVNamespace,
  key: string
): Promise<ReviewState> => {
  // KV 読み取りエラー（ストア障害）は握り潰さず上位へ伝播させる。握り潰すと
  // 「初回実行」とみなされ既存レビューを一斉再通知してしまうため。
  const raw = await kv.get(key, 'text');
  if (!raw) return {};

  // 壊れた JSON のみ空状態にフォールバックする。
  let json: Partial<ReviewState>;
  try {
    json = JSON.parse(raw) as Partial<ReviewState>;
  } catch {
    return {};
  }
  if (!json || typeof json !== 'object') return {};
  return {
    lastUpdated: typeof json.lastUpdated === 'string' ? json.lastUpdated : null,
    lastIds: Array.isArray(json.lastIds)
      ? json.lastIds.filter((x): x is string => typeof x === 'string')
      : [],
  };
};

export const saveReviewState = async (
  kv: KVNamespace,
  key: string,
  state: ReviewState
): Promise<void> => {
  await kv.put(key, JSON.stringify(state));
};
