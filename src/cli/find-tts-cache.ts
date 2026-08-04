/**
 * KV(TTS_KV) の voice:* メタを SSML 本文で検索し、必要なら KV ドキュメントと
 * R2 上の音声ファイルを削除する。旧 Firestore+GCS 版の Cloudflare 移植。
 *
 * KV の一覧・値取得・削除、R2 の削除、バケット名解決はすべて wrangler
 * （wrangler.jsonc + ログイン済みアカウント）経由で行うため、API トークンや
 * ネームスペース ID、R2 認証情報を環境変数で渡す必要はない（要 `wrangler login`）。
 *
 * 例:
 *   npm run find-tts-cache -- "東京" --field ssmlJa
 *   npm run find-tts-cache -- "東京" --delete
 *   npm run find-tts-cache -- "東京" --env production --delete
 */
import {
  confirm,
  kvDeleteKey,
  kvGetMany,
  kvListKeys,
  r2DeleteObject,
  resolveR2BucketName,
  type VoiceCacheRecord,
} from './lib/wrangler';

const KV_BINDING = 'TTS_KV';
const R2_BINDING = 'TTS_BUCKET';

interface CliArgs {
  searchTerm: string;
  field?: 'ssmlJa' | 'ssmlEn';
  exact: boolean;
  delete: boolean;
  env?: string;
}

function printUsage(): void {
  console.error(
    'Usage: npm run find-tts-cache -- <search-term> [--field ssmlJa|ssmlEn] [--exact] [--delete] [--env <name>]'
  );
  console.error('');
  console.error('Options:');
  console.error(
    '  --field <ssmlJa|ssmlEn>  検索対象フィールド（省略時は両方）'
  );
  console.error('  --exact                  部分一致ではなく完全一致で検索');
  console.error('  --delete                 KV ドキュメントと R2 音声を削除');
  console.error(
    '  --env <name>             対象環境（例: production。省略時は dev）'
  );
  console.error('');
  console.error(
    'KV / R2 の操作はすべて wrangler 経由（要 `wrangler login`）。環境変数の設定は不要。'
  );
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2);
  if (args.length === 0) return null;

  let searchTerm = '';
  let field: 'ssmlJa' | 'ssmlEn' | undefined;
  let exact = false;
  let deleteMode = false;
  let env: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--field': {
        const value = args[++i];
        if (value !== 'ssmlJa' && value !== 'ssmlEn') {
          console.error('Error: --field は "ssmlJa" か "ssmlEn" を指定');
          process.exit(1);
        }
        field = value;
        break;
      }
      case '--exact':
        exact = true;
        break;
      case '--delete':
        deleteMode = true;
        break;
      case '--env': {
        const value = args[++i];
        if (!value) {
          console.error('Error: --env には環境名を指定してください');
          process.exit(1);
        }
        env = value;
        break;
      }
      default:
        if (args[i].startsWith('--')) {
          console.error(`Error: 未知のオプションです: ${args[i]}`);
          process.exit(1);
        }
        if (searchTerm) {
          console.error(
            'Error: 検索語は 1 つだけ指定してください。複数語は引用符で囲んでください。'
          );
          process.exit(1);
        }
        searchTerm = args[i];
        break;
    }
  }

  if (!searchTerm) return null;
  return { searchTerm, field, exact, delete: deleteMode, env };
}

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv);
  if (!cliArgs) {
    printUsage();
    process.exit(1);
  }

  const { searchTerm, field, exact, delete: deleteMode, env } = cliArgs;

  console.log(
    `検索中: "${searchTerm}"${field ? ` (${field})` : ''}${exact ? ' [完全一致]' : ''} (env: ${env ?? 'dev (default)'})...\n`
  );

  const keys = await kvListKeys(KV_BINDING, 'voice:', env);
  const values = await kvGetMany(KV_BINDING, keys, env);
  const matches: VoiceCacheRecord[] = [];

  const matchValue = (value: string | undefined): boolean => {
    if (!value) return false;
    return exact ? value === searchTerm : value.includes(searchTerm);
  };

  for (const raw of values.values()) {
    let rec: VoiceCacheRecord;
    try {
      rec = JSON.parse(raw) as VoiceCacheRecord;
    } catch {
      continue;
    }
    // id 欠落レコードは voice:undefined / undefined.mp3 の誤削除を招くためスキップ
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
      continue;
    }
    const hit = field
      ? matchValue(rec[field])
      : matchValue(rec.ssmlJa) || matchValue(rec.ssmlEn);
    if (hit) matches.push(rec);
  }

  if (matches.length === 0) {
    console.log('一致するドキュメントが見つかりませんでした。');
    return;
  }

  console.log(`${matches.length}件のドキュメントが見つかりました:\n`);
  for (const rec of matches) {
    console.log(`ID:         ${rec.id}`);
    console.log(`SSML (JA):  ${rec.ssmlJa ?? ''}`);
    console.log(`SSML (EN):  ${rec.ssmlEn ?? ''}`);
    console.log(`Path (JA):  ${rec.pathJa ?? ''}`);
    console.log(`Path (EN):  ${rec.pathEn ?? ''}`);
    console.log(`Voice (JA): ${rec.voiceJa ?? ''}`);
    console.log(`Voice (EN): ${rec.voiceEn ?? ''}`);
    console.log(`Created:    ${rec.createdAt ?? 'N/A'}`);
    console.log('---');
  }

  if (!deleteMode) return;

  const confirmed = await confirm(
    `\n上記 ${matches.length}件の KV ドキュメントと R2 音声ファイルを削除しますか？ (y/N): `
  );
  if (!confirmed) {
    console.log('削除をキャンセルしました。');
    return;
  }

  const bucket = resolveR2BucketName(R2_BINDING, env);

  for (const rec of matches) {
    const id = rec.id;
    const pathJa = rec.pathJa ?? `caches/tts/ja/${id}.mp3`;
    const pathEn = rec.pathEn ?? `caches/tts/en/${id}.mp3`;
    console.log(`削除中: ${id}...`);

    // R2 を先に削除し、両方成功してから KV メタを消す。
    // KV を先に消すと、R2 削除が一時失敗した場合に孤立オブジェクトが残るため。
    const results = await Promise.allSettled([
      r2DeleteObject(bucket, pathJa),
      r2DeleteObject(bucket, pathEn),
    ]);
    const labels = ['R2 (JA)', 'R2 (EN)'];
    let hasFailure = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.warn(`  ${labels[i]} の削除に失敗: ${r.reason}`);
        hasFailure = true;
      }
    }
    if (hasFailure) {
      console.log(`  削除中断（R2 部分失敗のため KV メタは保持）: ${id}`);
      continue;
    }

    try {
      await kvDeleteKey(KV_BINDING, `voice:${id}`, env);
      console.log(`  削除完了: ${id}`);
    } catch (err) {
      console.warn(`  KV の削除に失敗: ${(err as Error).message}`);
    }
  }

  console.log(`\n${matches.length}件の処理が完了しました。`);
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
