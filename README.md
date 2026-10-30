# EMA-Break Futures Bot — fresh deployment

A MEXC futures trading bot: Convex backend + React dashboard. Signal scoring, risk gates and the
live/paper book logic are ported verbatim from a reference implementation — see
[PORTING.md](PORTING.md) for exactly what was inherited, what was reconstructed, and what is still
missing.

> **Forking this?** Everything environment-specific is configuration, not code. There is no
> deployment URL, API key or operator email in the source tree. Run `bun run setup:check` to see
> what your fork still needs.

## Read this before you run it

This bot can place real futures orders. Two rules are load-bearing:

- **Writes are gated, reads are public.** Every state-changing mutation calls
  `requireOperator()` (`src/convex/users.ts`): signed in **and** an email **and** that email is in
  `OPERATOR_EMAILS`. With `OPERATOR_EMAILS` unset it **refuses every write** — that is deliberate,
  a missing env var must never silently reopen a real-money book. Anonymous sign-in exists, so
  "signed in" is not a trust boundary.
- **The MEXC key is server-side only.** It is read in `src/convex/*` and never reaches the browser.
  Create it with **futures enabled and withdrawals DISABLED**, and IP-restrict it if you can.

## Requirements

- [Bun](https://bun.sh) (the lockfile is `bun.lock`; `bun install --frozen-lockfile` → 434 packages)
- A Convex account — you create **your own** project
- A MEXC futures API keypair (withdrawals off)

## Setup

### 1. Install

```bash
bun install --frozen-lockfile
```

### 2. Create your Convex project

In the Convex dashboard create a new project/deployment. You need two things from it:

- the deployment URL, `https://<your-deployment>.convex.cloud`
- a **deploy key** (Settings → Deploy Keys) if you are deploying headless

Never commit either. `convex.json` in this repo deliberately contains **no** team/project binding,
so pointing at a different project is purely an environment change.

### 3. Local config

```bash
cp .env.example .env.local
```

Fill in only the local section:

| name | where it goes |
|---|---|
| `VITE_CONVEX_URL` | `.env.local` — your `https://<deployment>.convex.cloud` |
| `CONVEX_DEPLOYMENT` | `.env.local` — your deployment name, or export `CONVEX_DEPLOY_KEY` instead |
| `CONVEX_DEPLOY_KEY` | **never** in `.env`/`.env.local`; CI secrets or your shell only |

`.env.local` is **optional** — an exported variable cannot be committed by accident, so prefer
the shell or CI:

```bash
export VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
export CONVEX_DEPLOYMENT=<your-deployment>      # or CONVEX_DEPLOY_KEY for headless
```

`VITE_CONVEX_URL` is inlined at **build** time, so changing projects means re-exporting and
rebuilding — no source edit. `bun run setup:check` reads the environment first and only falls back
to `.env.local` if the file happens to exist.

### 4. Deployment config

```bash
# Set the operator gate FIRST: without it, every settings write is refused.
npx convex env set OPERATOR_EMAILS you@example.com
npx convex env set SITE_URL https://your-app.example
npx convex env set MEXC_API_KEY <futures key, withdrawals disabled>
npx convex env set MEXC_API_SECRET <futures secret>
npx convex env set FREEBUFF_EMAIL_API_KEY <email OTP relay key>   # or swap the OTP provider
```

`CRONS_ENABLED` stays unset for now — leave the grid inert until the cache is seeded.

### 5. Deploy

```bash
npx convex deploy --yes          # headless, reads CONVEX_DEPLOY_KEY
```

`npx convex login` and interactive `npx convex dev` need a browser, so use the deploy-key path on a
headless machine.

### 6. Seed kline history, then start slow

```bash
bun run cache:seed            # signals need history from the first tick
npx convex env set CRONS_ENABLED 1
```

The 4h BTC regime and the advisor layer read cached klines. **An empty cache silently disables
those gates** — a quiet tick then means "no data", not "no setups".

Run **paper only** first. Arm live last, after `bun run audit:live` and `bun run lab:armcheck`.

## Scripts

| command | what it does |
|---|---|
| `bun run setup:check` | validate local + deployment config (never prints secrets) |
| `bun run dev` | Vite dev server |
| `bun run build` | `tsc -b && vite build` |
| `bun run test` | vitest |
| `bun run cache:seed` | download kline history into `data/klines/` |
| `bun run cache:update` | incremental daily top-up |
| `bun run audit:live` | audit the live book before arming |
| `bun run lab:armcheck` | arm-readiness check |
| `bun run scripts/verify-parity-replay.ts` | replay the signal core over cached bars |

## Status / known gaps

The reference implementation was **incomplete when published**: `src/convex/marketDataNode.ts`
(the Layer-1 market-data tick that writes the per-tick metrics every price-derived gate reads) and
`src/convex/downBlockShadow.ts` were never committed upstream. Until the former exists, this repo
typechecks and passes its tests but **cannot produce signals on a deployment**. Details, including
what was reconstructed and why certain crons are disabled, are in [PORTING.md](PORTING.md).
