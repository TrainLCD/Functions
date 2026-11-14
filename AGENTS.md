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
