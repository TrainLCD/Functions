/**
 * メンテ用 CLI から wrangler 経由で Cloudflare リソースを操作する共有ヘルパー。
 *
 * wrangler.jsonc のバインディング定義とログイン済みアカウント（`wrangler login`
 * もしくは CLOUDFLARE_API_TOKEN）を使うため、API トークンやネームスペース ID、
 * バケット名、R2 の S3 認証情報を環境変数で渡す必要がない。
 *
 * KV はサブコマンド（kv key list / kv bulk get / kv key delete）で扱う。wrangler には
 * R2 オブジェクトの一覧コマンドが無いため、R2 の列挙・削除はメンテ用 Worker
 * （src/cli/maintenance-worker.ts）を `wrangler dev --remote` で一時起動し、その
 * バインディング経由で行う（withMaintenanceWorker）。
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import { parse as parseJsonc } from 'jsonc-parser';

const execFileAsync = promisify(execFile);

// Windows では実行ファイルが npx.cmd になるため分岐する。
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// KV のキー一覧が大きくても標準出力を受け切れるよう拡張する。
const MAX_BUFFER = 256 * 1024 * 1024;

async function runWrangler(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(NPX, ['wrangler', ...args], {
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `wrangler ${args.join(' ')} に失敗しました: ${e.stderr?.trim() || e.message}`
    );
  }
}

const envArgs = (env?: string): string[] => (env ? ['--env', env] : []);

function extractJsonArray(out: string): string {
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `wrangler の出力を JSON 配列として解釈できませんでした: ${out.slice(0, 200)}`
    );
  }
  return out.slice(start, end + 1);
}

/**
 * KV ネームスペース内のキー名一覧を取得する（値は取得しない）。
 * wrangler が内部でページングするため、1 回の呼び出しで全件返る。
 */
export async function kvListKeys(
  binding: string,
  prefix: string,
  env?: string
): Promise<string[]> {
  const out = await runWrangler([
    'kv',
    'key',
    'list',
    '--binding',
    binding,
    '--prefix',
    prefix,
    '--remote',
    ...envArgs(env),
  ]);
  const parsed = JSON.parse(extractJsonArray(out)) as { name: string }[];
  return parsed.map((k) => k.name);
}

// CF の bulk/get API は 1 リクエストあたりのキー数に上限があるため分割する。
const BULK_GET_CHUNK = 100;

function extractJsonObject(out: string): string {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `wrangler の出力を JSON オブジェクトとして解釈できませんでした: ${out.slice(0, 200)}`
    );
  }
  return out.slice(start, end + 1);
}

// `wrangler kv bulk get` の値は環境により文字列 / { value } の両形がありうるため吸収する。
function normalizeBulkValue(entry: unknown): string | null {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && 'value' in entry) {
    const v = (entry as { value: unknown }).value;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/**
 * KV から複数キーの値をまとめて取得する（`wrangler kv bulk get`、open beta）。
 * 戻り値は存在したキーのみを含む Map。上限を超えないようチャンク分割して呼ぶ。
 */
export async function kvGetMany(
  binding: string,
  keys: string[],
  env?: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += BULK_GET_CHUNK) {
    const chunk = keys.slice(i, i + BULK_GET_CHUNK);
    const dir = mkdtempSync(path.join(tmpdir(), 'tts-kv-'));
    const file = path.join(dir, 'keys.json');
    try {
      writeFileSync(file, JSON.stringify(chunk));
      const stdout = await runWrangler([
        'kv',
        'bulk',
        'get',
        file,
        '--binding',
        binding,
        '--remote',
        ...envArgs(env),
      ]);
      const values = JSON.parse(extractJsonObject(stdout)) as Record<
        string,
        unknown
      >;
      for (const [k, entry] of Object.entries(values)) {
        const v = normalizeBulkValue(entry);
        if (v !== null) out.set(k, v);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

/** KV の単一キーを削除する（`wrangler kv key delete`。確認プロンプトは出ない）。 */
export async function kvDeleteKey(
  binding: string,
  key: string,
  env?: string
): Promise<void> {
  await runWrangler([
    'kv',
    'key',
    'delete',
    key,
    '--binding',
    binding,
    '--remote',
    ...envArgs(env),
  ]);
}

/** R2 の単一オブジェクトを削除する（`wrangler r2 object delete <bucket>/<key>`）。 */
export async function r2DeleteObject(
  bucket: string,
  key: string
): Promise<void> {
  await runWrangler(['r2', 'object', 'delete', `${bucket}/${key}`, '--remote']);
}

interface WranglerR2Binding {
  binding: string;
  bucket_name: string;
}

interface WranglerConfig {
  r2_buckets?: WranglerR2Binding[];
  env?: Record<string, { r2_buckets?: WranglerR2Binding[] }>;
}

/**
 * wrangler.jsonc から指定バインディングの R2 バケット名を解決する。
 * env を渡すとその環境（例: production）の設定を参照する。
 * JSONC のコメント・末尾カンマは jsonc-parser に任せる。
 */
export function resolveR2BucketName(binding: string, env?: string): string {
  const cfgPath = path.resolve(process.cwd(), 'wrangler.jsonc');
  const cfg = parseJsonc(readFileSync(cfgPath, 'utf8')) as WranglerConfig;
  const scope = env ? cfg.env?.[env] : cfg;
  const found = (scope?.r2_buckets ?? []).find((b) => b.binding === binding);
  if (!found?.bucket_name) {
    throw new Error(
      `wrangler.jsonc に R2 バインディング ${binding}${
        env ? ` (env=${env})` : ''
      } が見つかりません`
    );
  }
  return found.bucket_name;
}

// --- 共有: 標準入力での確認プロンプト ---

export function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// --- 共有: voice メタの型 ---
export interface VoiceCacheRecord {
  id: string;
  ssmlJa?: string;
  ssmlEn?: string;
  pathJa?: string;
  pathEn?: string;
  voiceJa?: string;
  voiceEn?: string;
  createdAt?: string;
}

// --- メンテ用 Worker（src/cli/maintenance-worker.ts）の起動と通信 ---
// wrangler に R2 一覧コマンドが無いため、R2/KV の列挙・削除はバインディング経由で行う。

const MAINT_WORKER_ENTRY = 'src/cli/maintenance-worker.ts';
const MAINT_WORKER_PORT = 8799;
const MAINT_READY_TIMEOUT_MS = 90_000;

export interface ScanResult {
  kvKeys: string[];
  jaKeys: string[];
  enKeys: string[];
}

export interface R2DeleteResult {
  key: string;
  ok: boolean;
  error?: string;
}

export interface MaintenanceClient {
  scan(): Promise<ScanResult>;
  deleteR2(keys: string[]): Promise<R2DeleteResult[]>;
}

async function waitForMaintReady(
  base: string,
  child: ChildProcess
): Promise<void> {
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + MAINT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        'wrangler dev が予期せず終了しました（`wrangler login` 済みか、設定が正しいか確認してください）'
      );
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // まだ起動中。
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('wrangler dev の起動がタイムアウトしました');
}

/**
 * メンテ用 Worker を `wrangler dev --remote` で一時起動し、クライアントを fn に渡す。
 * fn 完了後（例外時含む）に必ず Worker を停止する。環境変数は不要（要 `wrangler login`）。
 */
export async function withMaintenanceWorker<T>(
  env: string | undefined,
  fn: (client: MaintenanceClient) => Promise<T>
): Promise<T> {
  const token = randomUUID();
  const base = `http://127.0.0.1:${MAINT_WORKER_PORT}`;
  const child = spawn(
    NPX,
    [
      'wrangler',
      'dev',
      MAINT_WORKER_ENTRY,
      '--remote',
      '--ip',
      '127.0.0.1',
      '--port',
      String(MAINT_WORKER_PORT),
      '--var',
      `MAINT_TOKEN:${token}`,
      ...envArgs(env),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  try {
    await waitForMaintReady(base, child);
    const headers = { 'x-maint-token': token };
    const client: MaintenanceClient = {
      async scan() {
        const res = await fetch(`${base}/scan`, { headers });
        if (!res.ok) {
          throw new Error(
            `scan に失敗しました ${res.status}: ${await res.text()}`
          );
        }
        return (await res.json()) as ScanResult;
      },
      async deleteR2(keys) {
        const res = await fetch(`${base}/r2/delete`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ keys }),
        });
        if (!res.ok) {
          throw new Error(
            `R2 削除に失敗しました ${res.status}: ${await res.text()}`
          );
        }
        const data = (await res.json()) as { results: R2DeleteResult[] };
        return data.results;
      },
    };
    return await fn(client);
  } finally {
    child.kill('SIGTERM');
  }
}
