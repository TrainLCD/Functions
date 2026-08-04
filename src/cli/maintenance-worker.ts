/**
 * メンテ用 CLI 専用の使い捨て Worker。
 *
 * `wrangler dev --remote` で一時起動し、R2 / KV をバインディング経由で操作する。
 * wrangler には R2 オブジェクトの一覧コマンドが無いため、孤立 TTS 検出に必要な
 * 「R2 の全列挙」をこの Worker の `env.TTS_BUCKET.list()` で行う。これにより CLI 側は
 * S3 認証情報（環境変数）が不要になり、`wrangler login` だけで完結する。
 *
 * 本番 Worker（src/index.ts）とは別物で、デプロイ対象には含めない（dev 起動専用）。
 * localhost にしか bind しないが、念のため MAINT_TOKEN ヘッダで簡易認証する。
 */
interface MaintenanceEnv {
  TTS_KV: KVNamespace;
  TTS_BUCKET: R2Bucket;
  /** CLI が `--var` で渡す使い捨てトークン。未設定なら認証スキップ。 */
  MAINT_TOKEN?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });

/** KV から prefix 一致のキー名を全件返す（ページング込み）。 */
async function listKvKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const k of res.keys) names.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return names;
}

/** R2 から prefix 一致のオブジェクトキーを全件返す（ページング込み）。 */
async function listR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await bucket.list({ prefix, cursor });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

export default {
  async fetch(req: Request, env: MaintenanceEnv): Promise<Response> {
    const url = new URL(req.url);

    // 起動待ち用のヘルスチェックは無認証。
    if (url.pathname === '/health') return new Response('ok');

    if (
      env.MAINT_TOKEN &&
      req.headers.get('x-maint-token') !== env.MAINT_TOKEN
    ) {
      return json({ error: 'unauthorized' }, 401);
    }

    // KV(voice:) と R2(ja/en) を一括取得して返す。孤立判定は CLI 側で行う。
    if (req.method === 'GET' && url.pathname === '/scan') {
      const [kvKeys, jaKeys, enKeys] = await Promise.all([
        listKvKeys(env.TTS_KV, 'voice:'),
        listR2Keys(env.TTS_BUCKET, 'caches/tts/ja/'),
        listR2Keys(env.TTS_BUCKET, 'caches/tts/en/'),
      ]);
      return json({ kvKeys, jaKeys, enKeys });
    }

    // R2 オブジェクトをまとめて削除する。
    if (req.method === 'POST' && url.pathname === '/r2/delete') {
      const body = (await req.json()) as { keys?: unknown };
      const keys = Array.isArray(body.keys)
        ? body.keys.filter((k): k is string => typeof k === 'string')
        : [];
      const results: { key: string; ok: boolean; error?: string }[] = [];
      for (const key of keys) {
        try {
          await env.TTS_BUCKET.delete(key);
          results.push({ key, ok: true });
        } catch (e) {
          results.push({ key, ok: false, error: (e as Error).message });
        }
      }
      return json({ results });
    }

    return json({ error: 'not found' }, 404);
  },
};
