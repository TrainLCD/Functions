# TrainLCD Worker (Cloudflare)

The Cloudflare Worker that powers the TrainLCD backend. It replaces the former
Firebase Cloud Functions, consolidating the HTTP, queue, and Cron handlers into a
single Worker.

## Features

- **TTS synthesis** (`POST /tts`): synthesizes SSML into audio via Azure Speech and caches it in KV/R2.
- **Session issuance** (`POST /auth/token`): issues a short-lived session JWT from an install ID (the replacement for Firebase anonymous auth).
- **Feedback intake** (`POST /postFeedback`): enqueues feedback onto the triage queue.
- **Image upload** (`POST /feedback/upload-image`): stores feedback images in R2 and returns a public URL.
- **App config delivery** (`GET /config/maintenance`, `GET /config/remote`): maintenance status and GPS thresholds (the replacement for Remote Config).
- **Feedback triage** (queue `feedback-triage`): summarizes and classifies feedback with Workers AI, then creates a GitHub Issue and notifies Discord.
- **TTS cache writes**: synthesized audio is written directly from the `/tts` handler to R2 + KV (no queue is used, because audio does not fit within the 128 KB Queues limit).
- **Review notifications** (Cron, hourly): notifies Discord of new App Store / Google Play reviews.

## Tech stack

- **Cloudflare Workers** — `fetch` / `queue` / `scheduled` handlers
- **Workers KV** — TTS cache metadata, config, and review read-state
- **R2** — audio binaries and feedback images
- **Cloudflare Queues** — `feedback-triage`
- **Workers AI** — feedback triage
- **Azure Speech** — TTS synthesis (SSML)
- **Google Android Publisher API** — Google Play review retrieval (service-account JWT)
- **TypeScript / Biome / Jest / Wrangler**

## Prerequisites

- Node.js 22.x / npm
- Wrangler (installed as a devDependency via `npm install`)
- A Cloudflare account (with KV/R2/Queues/Workers AI enabled)

## Setup

```bash
cd functions
npm install
```

### Creating bindings

Replace the `id` / `bucket_name` placeholders in `wrangler.jsonc` with the real
values issued by the commands below (for both dev and prod).

```bash
# KV
wrangler kv namespace create TTS_KV
wrangler kv namespace create CONFIG_KV
wrangler kv namespace create STATE_KV
# R2
wrangler r2 bucket create trainlcd-tts-dev
wrangler r2 bucket create trainlcd-uploads-dev
# Queues
wrangler queues create feedback-triage-dev
```

### Setting secrets

```bash
wrangler secret put SESSION_JWT_SECRET          # signing key for session JWTs (any long random string)
wrangler secret put AZURE_SPEECH_KEY            # Azure Speech subscription key
wrangler secret put GOOGLE_PLAY_SA_KEY         # Android Publisher SA key JSON (single-line string)
wrangler secret put OCTOKIT_PAT
wrangler secret put DISCORD_CS_WEBHOOK_URL
wrangler secret put DISCORD_CRASH_WEBHOOK_URL
wrangler secret put DISCORD_REVIEW_WEBHOOK_URL
```

For local development, put the same keys in `.dev.vars` (gitignored).

You can also bulk-load secrets with the helper scripts: copy
`.secrets.env.example` to `.secrets.env`, fill in the values, then run
`./scripts/put-secrets.sh` (or `./scripts/put-secrets.ps1` on Windows).

### Non-secret configuration (vars)

See `vars` in `wrangler.jsonc`. Configure the Azure region, voice names, AI model
name, package name, public upload URL (the R2 public domain), and so on per
environment.

## Develop & deploy

```bash
npm run dev            # wrangler dev (local)
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
npm test               # jest (pure functions)
npm run deploy:dev     # wrangler deploy (dev)
npm run deploy:prod    # wrangler deploy --env production
npm run tail           # follow logs
```

## Client wire protocol

`POST /tts` and `POST /postFeedback` keep the Firebase callable-compatible wire
format.

- Request: `{ "data": { ... } }` with `Authorization: Bearer <session JWT>`
- Success: `{ "result": { ... } }`
- Failure: an HTTP status plus `{ "error": { "message", "status" } }`

A session JWT is obtained from `POST /auth/token` (body `{ "installId": "<uuid>" }`).

## Testing strategy

Unit tests cover pure functions (SSML formatting, voice-name resolution, triage
JSON normalization, review parsing) with Jest. Runtime integration for HTTP /
queue / Cron is verified with `wrangler dev` / `wrangler dev --test-scheduled`.

## few-shot data

Feedback triage reads `config:fewshot` (`FEW_SHOT_KV_KEY`) from `CONFIG_KV`.
The few-shot data is unrelated to TTS, so it lives in the config KV (the same
namespace as `config:maintenance` / `config:remote`). The format is JSONL, one
example per line (see `fewshot.example.jsonl`):

```json
{"input": "user body text", "output": "{\"title\":...,\"isSpam\":false,...}"}
```

Upload (the file is stored verbatim as a single KV value):

```bash
# dev (wrangler v4 defaults to the local emulator; --remote targets the real KV)
wrangler kv key put --binding CONFIG_KV "config:fewshot" --path fewshot.jsonl --remote
# prod
wrangler kv key put --binding CONFIG_KV "config:fewshot" --path fewshot.jsonl --env production --remote
```

If it is not present, triage fails hard with `FEW_SHOT_NOT_AVAILABLE` (a
fail-hard guard that prevents mis-training).

## Maintenance CLI

Maintenance tools that operate on KV (TTS_KV) and R2 (the audio bucket). Both
commands work entirely through `wrangler` (the bindings in `wrangler.jsonc` plus
your logged-in account), so **no environment variables are required** — just run
`wrangler login` first. Pass `--env production` to target production (it selects
the KV namespace and R2 bucket from `wrangler.jsonc`).

### `find-tts-cache`

Searches the TTS cache by SSML body and optionally deletes the matching KV
document and R2 audio. KV is read via `wrangler kv key list` / `wrangler kv bulk
get` and deleted via `wrangler kv key delete`; R2 audio is removed via `wrangler
r2 object delete`.

```bash
npm run find-tts-cache -- "東京" --field ssmlJa
npm run find-tts-cache -- "東京" --delete
npm run find-tts-cache -- "東京" --env production --delete
```

### `find-orphaned-tts`

Detects audio that exists in R2 but has no KV metadata (and optionally deletes
it). `wrangler` has no R2 object-listing command, so this command spins up a
short-lived maintenance Worker (`src/cli/maintenance-worker.ts`) via `wrangler
dev --remote` and enumerates/deletes R2 through its binding
(`env.TTS_BUCKET.list()` / `.delete()`). No S3 credentials are needed.

```bash
# dev (default)
npm run find-orphaned-tts
npm run find-orphaned-tts -- --delete
# production
npm run find-orphaned-tts -- --env production --delete
```
