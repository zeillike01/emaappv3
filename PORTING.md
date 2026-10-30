# PORTING RECORD — fresh deployment from `ema-break-appv2@freebuff/c18e1d1930d05b5f26c22341`

Source: `github.com/zeillike01/ema-break-appv2`, branch `freebuff/c18e1d1930d05b5f26c22341`
(HEAD `3de867b`). Copied as **code only** — no data, credentials, deployment, history or journals.

> **STATUS: NOT YET DEPLOYABLE.** One runtime module, `src/convex/marketDataNode.ts`, is
> imported by the cron grid but **was never committed to the reference repo** (verified absent
> from HEAD, all 40 published branches, and all 356 commits of the reference branch). It is the
> Layer-1 market-data tick that produces every price-derived gate input. See
> [BLOCKER](#blocker-marketdatanode) before deploying.

## Inherited verbatim

| Area | Files | Notes |
|---|---|---|
| Signal core | `layer2-signal.ts` (1610), `htf-advisor.ts` (1070), `strategy.ts` (849), `tracked-pairs.ts` (200), `session-breaker.ts` (496), `volume-centroid.ts` (217), `vol-floor.ts` (100), `ltf5m.ts` (83), `backtest.ts` (771) | plus the ~90 transitive lib modules they pull in (100 total under `src/lib`) |
| Exchange | `src/lib/mexc/*.ts` (6) | futures `https://contract.mexc.com`, spot `https://api.mexc.com`; contract size read from exchange meta at runtime |
| Convex | 33 modules incl. `strategyEngine`, `paperTrading`, `liveEngine`, `liveBrokerRuntime`, `liveBroker`, `liveReconcile`, `rLockExit`, `marketData`, `marketFetch`, `marketRelay`, `mexcForward`, `advisor`, `btcRegimeCache`, `htfCache`, `h4ShadowCache`, `d1ShadowCache`, `displacementScan`, `executionRecord`, `pairReview`, `heartbeat`, `cleanup`, `archive`, `mining`, `reset`, `users`, `cronWrappers`, `crons`, `schema`, `http`, `auth`, `auth.config` | `_generated/` kept because a clean checkout cannot typecheck or run two ported tests without it |
| Tests | `htf-advisor.test.ts`, `__tests__/operator-gate.test.ts`, `__tests__/reset.test.ts` | all 81 ported test files pass (1227 tests) |
| UI | `src/components`, `src/pages`, `src/hooks`, `src/main.tsx` | the React dashboard the operator drives |

## Deliberately NOT ported (per the brief)

- All 56 root `*.md` journals (P&L / strategy disclosure), every `run-*-lab.ts` (89 files),
  `scripts/luxmcp/*`, root `mech*.ts` / `probe-loop.ts`, and `src/lib/luxphase2/{pull-4y,pull-forward,probe-4y}.ts`
  (these last three hardcoded the reference deployment's relay URL).
- The reference's `.github/workflows/deploy-convex.yml` — it targets `tacit-cow-15` and would
  auto-deploy this repo to the reference project on push to main.
- Every `.env*` value and all Git history.
- `strategyConfig` / `liveDefaults` / `liveAccount` rows — the DB starts empty.

## Changes required to make it a *fresh* deployment

1. **`src/main.tsx`** — the reference hardcoded `new ConvexReactClient("https://tacit-cow-15.convex.cloud")`
   with a comment forbidding `VITE_CONVEX_URL`. Replaced with `import.meta.env.VITE_CONVEX_URL`
   plus a loud throw when unset. A hardcoded host is the one bug that would silently aim this
   UI's gated writes at another deployment's database.
2. **`package.json`** — dropped 68 scripts whose entry files were lab/research and are not in this
   tree (kept `cache:seed`, `cache:update`, `audit:live`, `lab:armcheck`, `test`, `build`, …).
3. **4 test files deleted** (`advisor-reprice-lab`, `exit-sweep-scaleout`, `ltf-dd-lab`,
   `ltf5m-short-lab`) — they import lab modules that the brief excludes.
4. **`.gitignore`** — `.env.local`, `.env.deploy`, `node_modules`, `dist`, `data/`.
5. **`.env.example`** — names only, split by local vs `npx convex env set` home.

## Reconstructed (NOT inherited — flagged for the parity audit)

- **`src/convex/tickTiming.ts`** — imported by `strategyEngine.ts`, `cronWrappers.ts` and
  `rLockExit.ts` and listed in `_generated/api.d.ts`, but the file was never committed upstream.
  Rebuilt from its three call sites and the existing `heartbeat.recordDuration` mutation: measure
  the body, stamp `lastDurationMs` best-effort, return the body's value unchanged, rethrow its
  errors unchanged. Pure instrumentation — it cannot alter a signal, a gate or a fill.

## Disabled (record-only, changes no gate)

- The `down-block-shadow-capture` / `down-block-shadow-resolve` crons are commented out in
  `src/convex/crons.ts`: their module `src/convex/downBlockShadow.ts` was never committed upstream
  and Convex validates cron targets at deploy time, so leaving them registered fails the
  deployment. The reference's own comment on that block reads *"Nothing in the trading path reads
  the table"* — this is the forward-test record of refused signals, not an entry gate.

## BLOCKER: `marketDataNode`

`src/convex/marketDataNode.ts` is referenced by `crons.ts` (`layer1-market-data`, every 15 min)
and by `StrategyConfigPanel` ("Run now"), and `marketData.ts` states plainly that *"THE TICK MOVED
to ./marketDataNode.ts (2026-10-28)"* — only the DB-facing halves stayed behind (`recordLayer1Tick`,
the run-guard lease, the slow-variable cache).

That missing module is what fetches ~94 MEXC reads per tick and writes the single `layer1Ticks`
doc per tick. It is the **producer of every price-derived gate input**: `atrPct` (ATR floor),
`spreadPct` (spread gate), `flowBias` (order-flow scoring), `candleRangePct`, `vol24h` (vol floor),
`fundingRate`, `imbalance`.

It is therefore **not reconstructable without inventing strategy inputs**. Writing a plausible
`computeMetricsForPair` would make every downstream parity claim meaningless while still passing
`tsc` and every test — the exact failure mode the brief forbids. The file must come from the
author's working copy (`layer1tick-validator.test.ts` also documents its contract: it pins the
validator to *"the Layer-1 tick WRITER (marketDataTick → recordLayer1Tick args)"*).

Also missing upstream (display-only, two pages no longer render these panels): 
`src/components/CoinPriorityCard.tsx`, `src/components/DownBlockForwardCard.tsx`.

## Verification actually run here

- `bun install --frozen-lockfile` → **434 packages** (matches the brief's expectation).
- `npx tsc -b` → **exit 0**.
- `npx vitest run` → **81 files / 1227 tests passed**; the three brief-mandated files: 42 + 6 + 7 = 55 passed.
- Gate constants confirmed identical to the inventory in `DEFAULT_CONFIG`
  (`layer2-signal.ts:441`): `emaFast 7`, `emaSlow 30`, `gapThreshold 0.02`, `minScore 8`,
  `minGap 2` (dead knob, kept), `stopLossPct 1.5`, `takeProfitPct 3.0` (2R), `spreadTight 0.04`,
  `spreadWide 0.12`, `atrSpikeMult 2.0`, `chopGatePeriod 10`, `chopGateFloor 0.25`.
- `requireOperator()` confirmed fail-closed: unset `OPERATOR_EMAILS` refuses **every** write;
  anonymous sessions are rejected on the email check; queries stay public.

Not run (needs the deployment + keys): live deployment, `audit:live`, `lab:armcheck`,
`cache:seed`, replay parity over a window, cron tick observation.

## Empty-database behaviour (what you get with zero rows)

Nothing is seeded and nothing needs to be: reads fall back to code defaults.

- `strategyConfig`: `getConfig` merges `DEFAULT_CONFIG` when no row exists; a row materialises on
  the first operator save (`updateConfig` / `resetConfig`).
- `liveDefaults`: `readLiveDefaults` falls back to `LIVE_DEFAULT_*` — schema documents
  **risk 1% / 50x / max 3 open**. These are the reference's built-in constants, *not* a choice for
  your account. Set them deliberately with `setLiveDefaults` before arming.
- Note: `npx convex run` carries **no user identity**, so every `requireOperator()`-gated mutation
  (`resetConfig`, `setLiveDefaults`, `updateConfig`, `setLiveEnabled`, …) is refused from the CLI.
  Seeding and arming happen from the signed-in operator UI.

## Deploy sequence (stopped before step 3 — no credentials in this sandbox)

```bash
bun install --frozen-lockfile
# 1. Convex project + key: dashboard → new project → Settings → Deploy Keys
#    Save the key as CONVEX_DEPLOY_KEY in project Secrets. Never in a file or chat.
# 2. Operator gate BEFORE the first deploy (otherwise every write is refused):
npx convex env set OPERATOR_EMAILS you@example.com
npx convex env set SITE_URL https://<your-app>
npx convex env set FREEBUFF_EMAIL_API_KEY <relay key>     # or swap the OTP provider
npx convex env set MEXC_API_KEY <new futures key>          # withdrawals OFF
npx convex env set MEXC_API_SECRET <new futures secret>
# 3. Deploy (headless; `convex login`/`convex dev` need a browser):
npx convex deploy --yes
# 4. Seed kline history BEFORE trusting a quiet tick — an empty cache silently
#    disables the 4h regime and advisor gates:
bun run cache:seed
# 5. Paper only. Leave CRONS_ENABLED unset until paperTrades is writing and
#    liveTrades is still empty. Arm live last, after audit:live + lab:armcheck.
```
