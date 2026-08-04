/**
 * R2 に存在するが KV(TTS_KV) に voice: メタが無い「孤立」音声ファイルを検出し、
 * 必要なら削除する。旧 Firestore+GCS 版の Cloudflare 移植。
 *
 * R2/KV の列挙・削除はメンテ用 Worker（src/cli/maintenance-worker.ts）を
 * `wrangler dev --remote` で一時起動し、そのバインディング経由で行う。よって
 * 環境変数は不要で、`wrangler login` 済みであれば動く。
 *
 * 例:
 *   npm run find-orphaned-tts                    # dev（既定）、検出のみ
 *   npm run find-orphaned-tts -- --delete        # dev、孤立ファイルを削除
 *   npm run find-orphaned-tts -- --env production --delete
 */
import { confirm, withMaintenanceWorker } from './lib/wrangler';

const ID_FROM_R2_KEY = /caches\/tts\/(?:ja|en)\/(.+)\.[^.]+$/;

function printUsage(): void {
  console.error(
    'Usage: npm run find-orphaned-tts -- [--env <name>] [--delete]'
  );
  console.error('');
  console.error(
    'R2 に存在するが KV にメタが無い孤立した TTS 音声ファイルを検出します。'
  );
  console.error(
    '  --env <name>             対象環境（例: production。省略時は dev）'
  );
  console.error('  --delete                 孤立ファイルを確認後に削除');
  console.error('');
  console.error(
    'R2/KV はメンテ用 Worker を wrangler dev --remote で起動して操作します（要 `wrangler login`）。環境変数は不要です。'
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let deleteMode = false;
  let env: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--delete') {
      deleteMode = true;
    } else if (a === '--env') {
      env = args[++i];
      if (!env) {
        printUsage();
        process.exit(1);
      }
    } else {
      printUsage();
      process.exit(1);
    }
  }

  console.log(`対象環境: ${env ?? 'dev (default)'}`);
  console.log('メンテ用 Worker を起動して R2/KV を取得中...');

  await withMaintenanceWorker(env, async (client) => {
    const { kvKeys, jaKeys, enKeys } = await client.scan();
    const kvIds = new Set(kvKeys.map((k) => k.replace(/^voice:/, '')));
    console.log(`  KV メタ数: ${kvIds.size}`);

    // id → そのidに紐づく R2 オブジェクトキー
    const filesById = new Map<string, string[]>();
    for (const key of [...jaKeys, ...enKeys]) {
      const m = key.match(ID_FROM_R2_KEY);
      if (!m?.[1]) continue;
      const id = m[1];
      const arr = filesById.get(id) ?? [];
      arr.push(key);
      filesById.set(id, arr);
    }
    console.log(
      `  R2 ファイル数: JA=${jaKeys.length}, EN=${enKeys.length} (ユニークID: ${filesById.size})`
    );

    const orphanedIds = [...filesById.keys()].filter((id) => !kvIds.has(id));
    if (orphanedIds.length === 0) {
      console.log('\n孤立ファイルはありませんでした。');
      return;
    }

    console.log(`\n${orphanedIds.length}件の孤立IDが見つかりました:\n`);
    for (const id of orphanedIds) {
      console.log(`  ${id} [${(filesById.get(id) ?? []).join(', ')}]`);
    }

    if (!deleteMode) {
      console.log('\n削除するには --delete を付けて再実行してください。');
      return;
    }

    const confirmed = await confirm(
      `\n上記 ${orphanedIds.length}件の孤立ファイルを R2 から削除しますか？ (y/N): `
    );
    if (!confirmed) {
      console.log('削除をキャンセルしました。');
      return;
    }

    const keys = orphanedIds.flatMap((id) => filesById.get(id) ?? []);
    const results = await client.deleteR2(keys);
    const failed = results.filter((r) => !r.ok);
    for (const f of failed) {
      console.warn(`  削除失敗: ${f.key}: ${f.error ?? 'unknown error'}`);
    }
    console.log(
      `\n${results.length - failed.length}/${results.length} 件の R2 オブジェクトを削除しました。`
    );
  });
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
