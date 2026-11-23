import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { migrationSettings, verifiedCopies } from './lib/legacyTts';
import {
  kvGetMany,
  kvListKeys,
  resolveR2BucketName,
  runWrangler,
} from './lib/wrangler';

async function main() {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const env = values.env;
  if (env && env !== 'production')
    throw new Error('対象は既定のdevまたはproductionです');
  const envArgs = env ? ['--env', env] : [];
  const bucket = resolveR2BucketName('TTS_BUCKET', env);
  const keys = await kvListKeys('TTS_KV', 'voice:', env);
  const known = new Set(keys);
  const config = await kvGetMany('TTS_KV', ['config:tts'], env);
  const settings = migrationSettings(
    JSON.parse(config.get('config:tts') ?? '{}')?.jaVoiceId,
    process.env
  );
  const dir = mkdtempSync(join(tmpdir(), 'tts-backfill-'));
  const file = join(dir, 'audio');
  let candidates = 0;
  let copied = 0;
  let missing = 0;
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const records = await kvGetMany('TTS_KV', keys.slice(i, i + 100), env);
      for (const [key, value] of records) {
        const record = JSON.parse(value);
        if (!record || key !== `voice:${record.id}`) continue;
        for (const copy of await verifiedCopies(record, settings)) {
          const targetKey = `voice:${copy.id}`;
          if (known.has(targetKey)) continue;
          if (values.apply) {
            try {
              await runWrangler([
                'r2',
                'object',
                'get',
                `${bucket}/${copy.source}`,
                '--file',
                file,
                '--remote',
              ]);
            } catch (err) {
              if (
                !/specified key does not exist|NoSuchKey|object does not exist/i.test(
                  String(err)
                )
              )
                throw err;
              missing++;
              continue;
            }
            if (!statSync(file).size) {
              missing++;
              continue;
            }
            await runWrangler([
              'r2',
              'object',
              'put',
              `${bucket}/${copy.target}`,
              '--file',
              file,
              '--content-type',
              copy.mimeType,
              '--remote',
            ]);
            await runWrangler([
              'kv',
              'key',
              'put',
              targetKey,
              JSON.stringify(copy.meta),
              '--binding',
              'TTS_KV',
              '--remote',
              ...envArgs,
            ]);
            copied++;
          }
          known.add(targetKey);
          candidates++;
        }
      }
    }
    console.log({
      environment: env ?? 'dev',
      records: keys.length,
      candidates,
      copied,
      missing,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
