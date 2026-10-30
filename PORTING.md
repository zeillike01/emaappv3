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
  `src/convex/crons.ts`: their module `src/convex/downBlockShadow.ts` was never committed upstream,
  so the registration targets a function that does not exist — an invalid cron target either fails
  push validation or, worse, installs a job that throws on every fire. (Not verified locally: there
  is no deployment here to push against. The `api.*` call path is proven broken differently — see
  BLOCKER.) The reference's own comment on that block reads *"Nothing in the trading path reads the
  table"* — this is the forward-test record of refused signals, not an entry gate.

## BLOCKER: `marketDataNode`

`src/convex/marketDataNode.ts` is referenced by `crons.ts` (`layer1-market-data`, every 15 min)
and by `StrategyConfigPanel` ("Run now"), and `marketData.ts` states plainly that *"THE TICK MOVED
to ./marketDataNode.ts (2026-10-28)"* — only the DB-facing halves stayed behind (`recordLayer1Tick`,
the run-guard lease, the slow-variable cache).

That missing module is what fetches ~94 MEXC reads per tick and writes the single `layer1Ticks`
doc per tick. It is the **producer of every price-derived gate input**: `atrPct` (ATR floor),
`spreadPct` (spread gate), `flowBias` (order-flow scoring), `candleRangePct`, `vol24h` (vol floor),
`fundingRate`, `imbalance`.

Evidence the reference cannot run as published: `StrategyConfigPanel.tsx` calls
`useAction(api.marketDataNode.marketDataTick)`, and an unresolvable function reference surfaces as
`Could not find public function ...` — the same failure class the reference's own `main.tsx` comment
documents. So the gap is not cosmetic even if a push happened to succeed.

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
cron tick observation.

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

## Audit (2026-10-30) — what was actually checked

**Verbatim port, proven by diff.** Every ported file was byte-compared against the reference
clone. Only 9 differ, each one a change recorded above: `.env.example`, `.gitignore`,
`package.json`, `src/convex/crons.ts`, `src/main.tsx`, `src/pages/{Live,Dashboard}.tsx`, plus
`PORTING.md` and `tickTiming.ts` which are new. Every other runtime file is identical.

**Nothing important was dropped.** 174 reference files were not ported: 62 journals, 93
`run-*`/`luxphase2` labs, 8 `scripts/luxmcp`, 2 CI files, 4 lab-only tests, and `.ignore`
(a ripgrep ignore file). No runtime module is among them.

**Invariants re-checked in the ported code.**
- Short book retired: no `shortBook` / short-book creation path anywhere in `src/`.
- Cron targets: 12 registrations; the three public `api.*` targets (`strategyTick`,
  `advisorTick`, `marketDataNode.marketDataTick`) are confirmed **ungated**, so the grid does not
  depend on an operator identity. The other nine are `internal.*`.
- Internal → gated calls: `liveBrokerRuntime`'s `api.liveEngine.{patchLiveTradePnl,
  markLiveClosed, markLiveCloseFailed, claimLiveClose, markLiveCloseSubmitted, assertLiveOwner}` are
  all **ungated**, so a live tick with no identity is not refused.
- Gated write surface (computed by body scan, wrapper-aware `requireLiveOwner` included):
  `liveEngine:assertLiveOwner`, `liveEngine:ensureLiveAccount`, `liveEngine:rearmLiveBreaker`, `liveEngine:setLiveEnabled`, `liveEngine:updateLiveSettings`, `liveEngine:setLiveDefaults`, `paperTrading:clearBtcFields`, `reset:resetBookData`, `strategyEngine:updateConfig`, `strategyEngine:resetConfig`.
  Two UI-only actions (`manualCloseLiveTradeSafe`, `probeLiveConnection`) call `assertLiveOwner` but
  each checks `ctx.auth.getUserIdentity()` first; no cron target and no tick is in the list above.

**Build.** `npx vite build` → exit 0 (7.7 s), so the React app compiles and bundles, not just
`tsc`.

**Caveat on the green typecheck.** `tsc` passes partly because `src/convex/_generated/api.d.ts` is
committed and `skipLibCheck` skips errors inside it — that file still declares the missing
`marketDataNode`/`downBlockShadow` modules. A real `convex deploy` regenerates it, and the two
references in `crons.ts` / `StrategyConfigPanel.tsx` then fail typecheck. The green result is
honest for the code that exists; it does not mean the stack is deployable.

**Left as-is, deliberately:** `package.json` `name` is still `vite-template`, and the root
`vly-toolbar-readonly.tsx` is unreferenced (it exists in the reference too). Neither affects
behaviour.

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

## Replay result (2026-10-30) — verification gate #2, run for real

Harness: `scripts/verify-parity-replay.ts` (added for this gate). It reads ONLY the local kline
cache with `localOnly: true`, so both trees consume byte-identical bars, and it runs the same
harness file copied into each tree.

| window | pair | signals | trades | win rate | return | maxDD | PF | vs reference |
|---|---|---|---|---|---|---|---|---|
| 2026-09-01→10-01 | BTC | 13 (L9/S4) | 13 | 23.1% | −9.902% | 17.496 | 0.710 | identical |
| 2026-09-01→10-01 | ETH | 14 (L12/S2) | 14 | 21.4% | −12.548% | 24.278 | 0.650 | identical |
| 2026-09-01→10-01 | SOL | 11 (L9/S2) | 11 | 9.1% | −21.829% | 21.829 | 0.238 | identical |
| 2026-05-15→10-01 | BTC | 96 (L51/S45) | 93 | 19.4% | −66.925% | 72.602 | 0.567 | identical |

Input files were `cmp`-compared before the run; `diff` over the harness output is empty on both
windows. Cache: 13,440 × 15m and 840 × 4h BTC bars, 2,976/186 for ETH and SOL.

**Scope warning — this is weaker than the brief's wording.** `runBacktest`/`scanForSignals` are the
legacy EMA-break core running the backtest's own defaults (SL 0.3 / TP 1.2 / 4H EMA75 filter). They
are **not** the shipped `layer2-signal.computeLayer2Signal` scoring, where `minScore 8`, the 7/30
EMA gap, the advisor veto, chop/ATR-floor/spread gates and the rest of the inventory live. So this
proves the ported backtest core reproduces the reference exactly on real bars; it does **not** prove
the shipped signal engine's per-pair entry counts. A `computeLayer2Signal` replay is still owed —
it needs per-bar metrics, BTC regime and advisor inputs assembled before it can run.

The negative returns are a property of those legacy defaults over these windows, not a verdict on the
shipped strategy, and not a reason to touch a threshold.

First run of this harness returned **0 signals in both trees** — identical, but vacuous. The cause was
mine: `CachedKline` was mapped to a `{time, ...}` shape while `Kline` keys pivots off
`openTime`/`closeTime`, so every variant produced nothing. Fixed in the harness and re-run. Recorded
here because "identical output" and "meaningful output" are different claims.
