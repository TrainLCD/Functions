# TrainLCD Worker (Cloudflare)

The Cloudflare Worker that powers the TrainLCD backend. It replaces the former
Firebase Cloud Functions, consolidating the HTTP, queue, and Cron handlers into a
single Worker.

## Features

- **TTS synthesis** (`POST /tts`): synthesizes plain text into audio via Google Cloud Text-to-Speech and caches it in KV/R2.
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
- **Google Cloud Text-to-Speech** — TTS synthesis (`Standard` voices, service-account auth)
- **OpenAI** — the conversational agent
- **Anthropic / Google Gemini (Vertex AI)** — alternative back ends for the
  conversational agent; the provider is selected by the `AGENT_MODEL` var
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
wrangler secret put GOOGLE_PLAY_SA_KEY         # Android Publisher SA key JSON (single-line string)
wrangler secret put OPENAI_API_KEY              # the conversational agent
wrangler secret put GOOGLE_TTS_SA_KEY           # Cloud Text-to-Speech SA key JSON (for POST /tts)
wrangler secret put GOOGLE_VERTEX_SA_KEY        # Vertex AI SA key JSON; only when AGENT_MODEL is "google:<model>"
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

See `vars` in `wrangler.jsonc`. Configure the TTS voice names and delivery
(`TTS_SPEED` / `TTS_PITCH`), AI model name, package name, public upload URL (the
R2 public domain), and so on per environment.

Synthesis runs on Google Cloud Text-to-Speech, which authenticates with a service
account rather than an API key: `GOOGLE_TTS_SA_KEY` holds the key JSON and the
Worker signs a JWT with Web Crypto to obtain an access token. The Cloud
Text-to-Speech API must be enabled on that project. Unlike the agent providers,
TTS is not routed through Cloudflare AI Gateway (Cloud TTS is not a supported
gateway provider).

The conversational agent picks its provider from `AGENT_MODEL`, written as
`<provider>:<model id>`:

| `AGENT_MODEL`             | Provider                | Required secret        |
| ------------------------- | ----------------------- | ---------------------- |
| `openai:gpt-5.6-luna`     | OpenAI                  | `OPENAI_API_KEY`       |
| `anthropic:<model>`       | Anthropic               | `ANTHROPIC_API_KEY`    |
| `google:gemini-3.7-flash` | Google Vertex AI        | `GOOGLE_VERTEX_SA_KEY` |

Switching providers is a vars-only change (`wrangler deploy`) **as long as that
provider's secret is already set** — no code change is needed. If it is missing,
`/agent/chat` fails on every request (the model resolver throws
`<SECRET> is not configured`), so put the secret in before flipping
`AGENT_MODEL`. When `AI_GATEWAY_BASE_URL` is set, every provider is routed
through Cloudflare AI Gateway (`/anthropic/v1`, `/openai`,
`/google-vertex-ai/v1beta1`) with request bodies excluded from the gateway logs.

Gemini runs on **Vertex AI**, which authenticates with Google Cloud credentials
(ADC) rather than an API key. Workers have no ADC, so `GOOGLE_VERTEX_SA_KEY`
holds a service-account key JSON (role: *Vertex AI User*) and the Worker signs a
JWT with Web Crypto to obtain an access token per request. Two optional vars go
with it: `GOOGLE_VERTEX_PROJECT` (defaults to the key's `project_id`) and
`GOOGLE_VERTEX_LOCATION` (defaults to `global`).

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

### `POST /tts`

Synthesis runs on Google Cloud Text-to-Speech. The client sends plain text; SSML
is **not** interpreted (stray tags are stripped server-side rather than read
aloud), and delivery is steered by the `TTS_SPEED` / `TTS_PITCH` vars.

```json
{
  "data": {
    "textJa": "次は、オオサキです",
    "textEn": "The next station is Osaki, J-Y 24.",
    "jaVoiceName": "ja-JP-Standard-B",
    "enVoiceName": "en-US-Standard-G"
  }
}
```

Every field is optional except that **at least one of `textJa` / `textEn` must
be present**. Synthesis is billed per character, so the app omits a language the
user has switched off; only the languages it asks for are synthesized, cached,
and returned. Voice names are checked against an allowlist of voices that are
known to exist (`ja-JP` / `en-US` in the `Standard` / `Wavenet` / `Neural2`
families) — anything else falls back to the KV config (`config:tts`) and then to
the `TTS_*` vars. That keeps a client from naming an arbitrary (far more
expensive) voice such as `Studio`, `Chirp3-HD`, or a Gemini-TTS voice, and also
keeps a well-formed but non-existent name (`ja-JP-Standard-Z`) from reaching the
API, where it would fail the whole request with a 400. Using another locale
means adding its voices to the list in `src/utils/ttsVoice.ts`. The `model` / `instructions*`
fields of the previous OpenAI-based engine are accepted but ignored, so older
app builds keep working.

The response carries only the requested languages:

```json
{
  "result": {
    "id": "<sha256 of the request, used as the cache key>",
    "jaAudioContent": "<base64>",
    "jaAudioMimeType": "audio/mpeg",
    "enAudioContent": "<base64>",
    "enAudioMimeType": "audio/mpeg"
  }
}
```

## Testing strategy

Unit tests cover pure functions (TTS request building, voice/model resolution,
text validation, cache writes, triage JSON normalization, review parsing) with
Jest. Runtime integration for HTTP /
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

Searches the TTS cache by spoken text and optionally deletes the matching KV
document and R2 audio. KV is read via `wrangler kv key list` / `wrangler kv bulk
get` and deleted via `wrangler kv key delete`; R2 audio is removed via `wrangler
r2 object delete`.

```bash
npm run find-tts-cache -- "東京" --field textJa
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
