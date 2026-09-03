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
- **Feedback triage** (queue `feedback-triage`): summarizes and classifies feedback with Workers AI, then creates a GitHub Issue and notifies Discord. Actionable feedback whose root-cause component the AI identifies confidently also gets a linked stub Issue in the matching public repo (see [public repo routing](#public-repo-routing) for the exact conditions).
- **TTS cache writes**: synthesized audio is written directly from the `/tts` handler to R2 + KV (no queue is used, because audio does not fit within the 128 KB Queues limit).
- **Review notifications** (Cron, hourly): notifies Discord of new App Store / Google Play reviews.

## Tech stack

- **Cloudflare Workers** — `fetch` / `queue` / `scheduled` handlers
- **Workers KV** — TTS cache metadata, config, and review read-state
- **R2** — audio binaries and feedback images
- **Cloudflare Queues** — `feedback-triage` (+ `feedback-triage-dlq` as its dead letter queue)
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
wrangler queues create feedback-triage-dev-dlq   # dead letter queue (no consumer)
```

The names above are the dev ones. Production uses the same set without the
`-dev` suffix (`trainlcd-tts`, `trainlcd-uploads`, `feedback-triage`,
`feedback-triage-dlq`); create those too if you are setting up prod from
scratch. Both environments' resources already exist on the TrainLCD account.

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
| `google:gemini-3.8-flash` | Google Vertex AI        | `GOOGLE_VERTEX_SA_KEY` |

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

The `output` of each example must include `component` / `componentConfidence`
as well; the model imitates the examples, so examples without those fields make
it omit them and public repo routing never fires.

Optional per-example fields: `weight` (a value above 1 makes the example more
likely to survive sampling) and `disabled: true` (skips the line). Only
`FEW_SHOT_LIMIT` examples are sampled per request, so a component or category
with a single example — `praise`, `functions`, `website` — must carry a
`weight`, otherwise it drops out of the prompt and the model never produces it.

Upload (the file is stored verbatim as a single KV value):

```bash
# dev (wrangler v4 defaults to the local emulator; --remote targets the real KV)
wrangler kv key put --binding CONFIG_KV "config:fewshot" --path fewshot.jsonl --remote
# prod
wrangler kv key put --binding CONFIG_KV "config:fewshot" --path fewshot.jsonl --env production --remote
```

If it is not present, triage fails hard with `FEW_SHOT_NOT_AVAILABLE` (a
fail-hard guard that prevents mis-training).

## Triage safeguards

Two guards keep bad triage output from degrading the backlog
(`src/consumers/feedbackTriage.ts`):

- **Gratitude is never spam.** Praise-only feedback gets `category: "praise"`
  (`💚 Praise`, P3) instead of `💩 Spam` — there is nothing to fix, but it is
  still a real message from a real user. Spam means content unrelated to
  improving the app: announcement transcripts, unrelated chit-chat, ads.
- **Spam heuristic is advisory, not authoritative.** `looksLikeSpam()` only
  scores announcement-transcript signals when an actual announcement phrase is
  present — "停車駅" / "方面" / station enumerations are core domain vocabulary
  and appear in legitimate data reports. When the heuristic and the model
  disagree and the model is confident (`confidence` ≥
  `SPAM_OVERRIDE_MAX_CONFIDENCE`), the model wins and the Issue is tagged
  `❓ Unknown Type` for a human check instead of being buried as spam.
- **Broken titles never reach the backlog.** `findBrokenTitleReason()` rejects
  titles that are missing, mojibake, foreign-script, looping, or a run of
  particles. Those are filed with the `要約失敗` marker plus `❓ Unknown Type`,
  and a `console.warn` records the reason so the corruption rate can be measured
  with `wrangler tail`. A broken title is never propagated into the summary.

`AI_TRIAGE_MODEL` therefore needs decent Japanese generation quality — it writes
the Issue title and summary. Before switching it, verify three things against the
real prompt (`wrangler dev` with the AI binding hits the live API even locally):

1. **JSON schema mode is supported** — `wrangler ai models schema <model>` must
   list `response_format` / `json_schema`.
2. **The response shape** — some models return `response`, others only
   `choices[0].message.content`. `pickModelResponse()` accepts both; a model
   returning neither would fail every message.
3. **`max_tokens` headroom** — reasoning models spend most of the budget on the
   trace before the JSON. Watch for `finish_reason: "length"`, which truncates
   the JSON and looks like a parse failure.

Measured with the real prompt + few-shot (2026-08): `@cf/google/gemma-4-26b-a4b-it`
completes in 5–17 s at 26–62 neurons per feedback, versus ~1 s and ~4.7 neurons
for the old 8B model. Queue consumers use `max_batch_size: 5`, so a batch stays
well inside the invocation limit.

### Dead letter queue

`processFeedbackMessage()` rethrows on failure so the consumer can `retry()`,
but retrying does not help when the cause is permanent — a credential that no
longer grants access, a repo that was renamed. Without a dead letter queue the
message is simply dropped once `max_retries: 3` is exhausted, and the feedback
is lost for good.

The consumers therefore declare `dead_letter_queue` (`feedback-triage-dlq`, and
`feedback-triage-dev-dlq` for dev). The DLQ intentionally has **no consumer** —
running the same handler against it would fail for the same reason.

Do not look for the wiring on the DLQ itself. Moving a message into a DLQ is
something Cloudflare does internally, not something the Worker sends, so a
correctly configured DLQ still reports zero producers and zero consumers in
`wrangler queues list`. The link lives on the **source** queue's consumer, and it
only exists once the config has been deployed:

```bash
wrangler queues consumer list feedback-triage-dev   # or feedback-triage for prod
# dead_letter_queue must name the DLQ; "-" means this environment is still
# dropping messages once max_retries is exhausted.
```

**A DLQ is not archival storage.** Messages sitting in it expire on the queue's
retention period, which both DLQs inherit from the account default (4 days on a
paid plan, and not extendable beyond 24 h on the free plan). That is the replay
deadline: once it passes the feedback is gone just as surely as it was before
this queue existed. Check and extend it if an incident may outlast it:

```bash
# 1209600 = 14 days, the paid-plan maximum. The free tier is capped at 86400
# (24 h) and rejects anything above it, so use that value instead on free.
# Run this for the dev DLQ too — retention is per queue, and
# feedback-triage-dev-dlq inherits nothing from the prod one.
RETENTION=1209600
for q in feedback-triage-dlq feedback-triage-dev-dlq; do
  wrangler queues update "$q" --message-retention-period-secs "$RETENTION"
done
```

`wrangler queues info` does not print the retention period (as of wrangler 4.103),
so there is no CLI read-back for it — set it explicitly, or check the dashboard.

To recover, fix the root cause first, then replay by temporarily attaching a
consumer to the DLQ. Give that consumer its own dead letter queue — a replay
consumer runs the same handler, so anything still failing would hit `max_retries`
and be deleted outright, which is the exact loss this section exists to prevent.

```bash
# production. For dev: DLQ=feedback-triage-dev-dlq, SCRIPT=trainlcd-worker-dev
DLQ=feedback-triage-dlq
SCRIPT=trainlcd-worker
RETENTION=1209600   # 86400 on the free tier, as above

wrangler queues info "$DLQ"    # backlog size, current consumers

# Catches whatever still fails on replay. Give it the same retention as the DLQ,
# otherwise it silently falls back to the account default.
wrangler queues create "$DLQ-quarantine" --message-retention-period-secs "$RETENTION"

# --batch-size 5 matches the max_batch_size the regular consumer runs with; the
# default of 10 is a lot for one invocation at 5–17 s of inference per message.
wrangler queues consumer add "$DLQ" "$SCRIPT" \
  --dead-letter-queue "$DLQ-quarantine" --batch-size 5

# ...wait for the backlog to drain, then detach:
wrangler queues consumer remove "$DLQ" "$SCRIPT"
```

The replay consumer is deliberately not declared in `wrangler.jsonc` — it exists
only for the duration of an incident, so nothing will remove it for you. Leaving
it attached means every later failure gets reprocessed by it instead of landing
in the DLQ where you can see it.

`$DLQ-quarantine` outlives the incident as well. `queues create` fails if it
already exists, so on the next incident either reuse it (confirm it is empty
first — anything left in it is unprocessed feedback) or `wrangler queues delete`
it once you have dealt with whatever landed there.

Note that DLQ messages carry the full feedback payload, so the DLQ is subject to
the same handling rules as the private `TrainLCD/Issues` repo.

### Retry idempotency

A retry re-runs `processFeedbackMessage()` from the top, so anything that throws
*after* the Issue has been created files the same feedback again — up to four
Issues with `max_retries: 3`, plus one more for every DLQ replay.

To prevent that, the consumer keeps a per-report marker in `STATE_KV` under
`feedbackTriage:processed:<report.id>` (30-day TTL, long enough to cover a DLQ
replay). It records the created Issue number and URL, the public stub URL, the
triage result, and whether the Discord notification went out. The marker decides
what each delivery still has to do:

- **notified** — nothing. The message is acked and dropped.
- **Issue created, not notified** — skip triage and Issue creation, re-send the
  Discord notification only. The stored triage result is reused instead of being
  re-inferred, so the notification matches the Issue that was already filed, and
  the retry costs no Workers AI neurons.
- **no marker** — the full path, writing the marker as soon as the Issue exists.

Nothing between the Issue being created and the marker being written may throw,
because a throw there is a retry with no marker to stop it. So a malformed
Issue-creation response and a failed marker write are logged and swallowed, and
`notifyDiscord()` turns every failure into a return value instead of an
exception — including `fetch()` itself rejecting on a network or DNS error,
which is what made this reachable in practice.

Past that point a throw is safe, and one is deliberate. The marker records
whether Discord actually accepted the request, so a failed notification is saved
as `notified: false` and *then* rethrown as `FeedbackNotifyError`, which retries
the message: the retry reads the marker, skips straight to the notification, and
leaves the Issue alone. Retrying the handler for a Discord outage is exactly
what used to duplicate Issues — the marker is what makes it safe now. A
notification that never succeeds ends up in the DLQ after `max_retries`, which
is how a broken webhook becomes visible.

The one case that is *not* retried is a notification failure where the marker
write also failed. Without the marker a retry would file the Issue again, so the
notification is given up and the message acked — the feedback is on GitHub
either way.

**KV is not a lock, and the marker read is what makes this work — so the retry
has to be slow enough for the read to see it.** KV caches the *absence* of a key
at the edge for the read's `cacheTtl` (60 s by default), so a retry that runs
immediately after the failure can miss a marker that was written seconds ago and
file the Issue again. The consumer therefore retries with
`message.retry({ delaySeconds: FEEDBACK_RETRY_DELAY_SECONDS })` (90 s) so the
negative cache has expired by the time the marker is read. Changing that
constant without understanding this is how the duplicate comes back.

The same limit applies to the writes: KV accepts at most one write per second to
a given key, and one report writes that key twice — once when the Issue exists,
once when the notification result is known. A notification that completes in
under a second would make the second write a 429, so the consumer spaces writes
to the same key ~1.1 s apart (and waits that long before its one write retry)
rather than losing the notification state and re-notifying on a replay.

That covers the sequential retries of one message. It does **not** serialize two
deliveries of the same report racing each other — Cloudflare Queues is
at-least-once, so that race is possible in principle, and with an eventually
consistent read there is nothing to make it safe. Strict de-duplication would
take a per-report claim in a Durable Object (the only strongly consistent option
here), which is a bigger change than the failure it covers.

One gap stays open by design: if the Issue-creation `fetch()` fails *after*
GitHub has already created the Issue, no marker was written and the retry files
a second one. Closing that would mean searching `TrainLCD/Issues` by ticket ID
before every creation, which costs a request per feedback for a case that needs
GitHub to drop the response of a request it accepted.

## Public repo routing

Feedback Issues are always created in the private `TrainLCD/Issues` repo with
the full report (original text, device info, reporter UID, stacktrace, image).

On top of that, the worker opens a stub Issue in the matching public repo — but
only when **every** condition in `resolvePublicIssueRepo()` holds:

1. `reportType` is `feedback` (crash reports are never routed — their stacktraces
   are not vetted for public disclosure),
2. triage succeeded (`triageFailed === false`) and the report is not spam,
3. the heuristic did not flag it for human review (`needsSpamReview !== true`),
4. `category` is one of `PUBLIC_ISSUE_CATEGORIES` — `bug`, `improvement`,
   `feature_request` (so `question` and `praise` are excluded), and
5. `component` ≠ unknown with `componentConfidence` ≥
   `PUBLIC_ISSUE_MIN_CONFIDENCE` (0.7).

The component then selects the repo:

| `component`   | repo                 |
| ------------- | -------------------- |
| `mobile_app`  | `TrainLCD/MobileApp` |
| `station_api` | `TrainLCD/StationAPI`|
| `functions`   | `TrainLCD/Functions` |
| `website`     | `TrainLCD/Website`   |

Because those repos are public, the stub carries **no feedback content at all** —
no original text, no AI summary or title, no device info. It only links back to
the private ticket (`TrainLCD/Issues#<number>` and the ticket ID), and the
private Issue gets a comment pointing at the public one so both sides are
traceable.

`OCTOKIT_PAT` therefore needs write access to those four repos on top of
`TrainLCD/Issues`.

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
