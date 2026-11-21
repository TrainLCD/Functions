# Repository Guidelines

## Project Structure & Module Organization

This is the Cloudflare Worker backend for TrainLCD. `src/index.ts` wires together HTTP, queue, and scheduled handlers. Keep endpoints in `src/routes/`, queue consumers in `src/consumers/`, Cron jobs in `src/scheduled/`, and integrations in `src/lib/`. Agent logic lives in `src/agent/`, shared models in `src/models/`, and maintenance commands in `src/cli/`. Tests are colocated as `*.test.ts`; shared Jest stubs live in `test/stubs/`. Deployment configuration is in `wrangler.jsonc`.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node.js 22 or newer is required.
- `npm run dev`: start the Worker locally with Wrangler.
- `npm test`: run the Jest unit suite once. Use `npm test -- --watch` while developing.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run lint`: check formatting and lint rules with Biome.
- `npm run format`: rewrite supported files to Biome formatting.
- `npm run deploy:dev` / `npm run deploy:prod`: deploy the development or production environment.

Before submitting changes, run `npm run typecheck && npm run lint && npm test`.

## Coding Style & Naming Conventions

Use strict TypeScript; avoid `any`, parameter reassignment, and non-null assertions. Biome enforces two-space indentation, single quotes, and ES5-style trailing commas. Use `camelCase` for functions and variables, `PascalCase` for types, and descriptive filenames (for example, `feedbackTriage.ts`). Keep handlers thin and move testable logic into focused utilities.

## Testing Guidelines

Jest runs through `ts-jest` in a Node environment. Name tests `*.test.ts` beside the source they cover. Mock network, AI-provider, and Cloudflare-boundary behavior; shared AI stubs already exist under `test/stubs/`. Cover success paths, invalid input, and operational failure modes. Verify runtime integrations manually with `npm run dev`; scheduled handlers can be exercised with `wrangler dev --test-scheduled`.

## Commit & Pull Request Guidelines

This repository uses git-flow: `dev` is the development branch and `master` the release branch. Branch from `dev` as `feature/<topic>`, `fix/<topic>`, or `release/<version>`; reserve `master` for releases. Use concise, imperative commit summaries, often in Japanese. Pull requests must assign `@TinyKitten`, target the appropriate git-flow branch, explain the motivation and behavior, link issues, list verification commands, and call out binding, secret, queue, KV, R2, or Cron changes. Include request/response examples for API changes.

## Security & Configuration

Never commit `.dev.vars`, `.secrets.env`, API keys, tokens, or service-account JSON. Start from `.secrets.env.example`, use Wrangler secrets for deployed environments, and review both development and production sections of `wrangler.jsonc` when changing bindings.

## Investigate Impact Before Changing Code

- **Finish the relevant investigation before editing application code.** Record the requested outcome, existing behavior and its evidence, dependencies, expected impact, and a concrete validation plan in the task discussion before implementation. Carry that record into the PR. A promise to investigate later is not a substitute.
- **Trace the complete data flow.** Follow producers through callers, indirect consumers, shared state and caches to displayed output or external effects. Check cache keys and ordering, prefetch versus on-demand requests, and what happens after user actions, retries, or failures. A missing prop or a single unused reference does not prove that data is unused. Treat similar UI or API paths separately until their dependencies are verified.
- **Define the impact and tests first.** Identify what will change and what must remain unchanged for normal cases, boundaries, empty or missing data, and failures. Map each preservation claim to a specific test or inspection. For performance work, distinguish fewer requests or smaller payloads from measured latency; do not promise a speedup without measurement.
- **Resolve material unknowns before dependent changes.** Investigate facts available in the repository or connected sources instead of asking the user to do that work. If intended behavior remains ambiguous, explain the evidence and concrete alternatives, then ask before implementing the dependent change. Continue independent investigation. Do not treat agent-written issues or review suggestions as authorization to change behavior.
- **Preserve the approved contract.** Do not hide missing data by dropping items, or change filters, search criteria, ordering, selection priorities, fallbacks, or error behavior without authorization. Do not weaken existing tests to make a new implementation pass. Reuse prior authorization rather than asking again for the same scope.
- **Report evidence precisely.** Separate planned checks from completed checks and automated tests from real UI or deployed-service verification. Do not call behavior unchanged, data unused, or a fix verified until the relevant path has been checked. State any remaining validation limits in the PR.

For this Worker, trace HTTP, queue, and scheduled entry points through authentication, integrations, retries, and KV/R2 caches to responses and external effects. Check development and production configuration, idempotency, and client compatibility where affected. Use mocked boundaries for tests; do not trigger paid AI calls or live notifications merely to validate documentation or unrelated changes.

### Example: TTS request and shared cache

Use this as a starting point, not an exhaustive dependency map; re-check the current code and follow the paths affected by the task.

- `src/index.ts` routes `POST /tts` through `withCallable` to `handleTts` in `src/routes/tts.ts`. It verifies the session via `src/lib/auth/session.ts`, parses the requested languages, and normalizes English text before computing the cache ID.
- `getTtsConfig` reads `TTS_KV["config:tts"]` through an in-memory cache. `src/utils/ttsVoice.ts` resolves allowed voices from request, KV, environment, then built-in defaults. `computeId` includes the resolved voices, normalized text, speed, pitch, format, and hash version; trace these inputs before changing cache reuse.
- `handleTts` reads `TTS_KV["voice:<id>"]`, then follows its language-specific paths into `TTS_BUCKET`. A complete hit returns base64 audio through `callableSuccess`; missing audio or an R2 read failure falls through to `synthesizeSpeech` in `src/lib/google/tts.ts` for the requested languages. Do not assume KV read failures use the same fallback.
- After synthesis, `ctx.waitUntil` calls `writeTtsCache` in `src/lib/ttsCache.ts`: R2 audio writes finish before KV metadata is written for later requests. Cache-write errors are logged independently of the audio response; this path does not use a queue.
- For changes along this path, inspect `src/routes/tts.test.ts` for cache-ID and input cases and `src/lib/ttsCache.test.ts` for saved languages and metadata. Add mocked checks for affected behavior those tests do not cover, especially cache-hit/miss and failure branches; check the development and production TTS bindings in `wrangler.jsonc`.

## Required Issue Linkage Before PR Publication

- Every PR must include a real Issue reference in its related-issue section, including documentation, dependency, release, synchronization, and automated PRs.
- Before publishing a PR branch, search existing open and closed Issues by the problem, purpose, and affected component. Read candidate Issues and verify their identity and scope. Reuse an Issue for the same work, including an appropriate Issue in another repository; do not create a duplicate simply because it is closed or belongs elsewhere.
- Only when no matching Issue exists, create one with the purpose, scope, and acceptance criteria before publishing the branch or PR. Issue creation is part of an authorized PR request and needs no additional confirmation. Assign it to `TinyKitten` unless the user explicitly names another assignee or requests no assignee. Failed or incomplete searches, reads, or creation are not evidence that no Issue exists: stop publication and report the failure.
- For work this PR completes, use `Closes #123`; for partial work or a reference that must remain open, use `Refs #123`. Across repositories, use `Closes TrainLCD/Repository#123` or `Refs TrainLCD/Repository#123`. Do not automatically turn bare numbers into closing references.
- Closing keywords in a PR body do not automatically close Issues when the base is not the default branch. After such a merge, manually close only Issues explicitly named by `Closes` whose acceptance criteria are satisfied. Never close `Refs` references through this procedure, even if their criteria are met; leave partial and unfinished work open.
- Empty references, “none”, and references appearing only in template comments are not allowed. Release and synchronization PRs may reuse the Issues for their included changes without closing unfinished work. Automated feedback PRs may reuse their verified source or stub Issue; do not copy private feedback into a public Issue or PR.
- Apply the same rules when updating an existing PR: add missing references, preserve valid references and explanations, and deduplicate by repository and Issue number. Re-read the published PR body to verify the references after creation or updates.
- Follow `.github/pull_request_template.md`. Keep future PR-creation skills, scripts, and workflows consistent with these requirements. Preserve the existing PR assignee and git-flow rules above.
