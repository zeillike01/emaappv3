# Re-porting this project from scratch — verified recipe

Use this if you want to rebuild the port yourself rather than trust the copy already here.
`PORT-MANIFEST.sha256` is the checksum of every tracked file, so a re-port can be compared
byte-for-byte instead of argued about.

Source: `github.com/zeillike01/ema-break-appv2`, branch `freebuff/c18e1d1930d05b5f26c22341`,
HEAD `3de867b2`. Use that branch — `main` lacks the operator gate and contains a hardcoded email key.

## 1. Copy the runtime tree

```bash
git clone --branch freebuff/c18e1d1930d05b5f26c22341 --depth 1 \
  https://github.com/zeillike01/ema-break-appv2.git /tmp/ref
rsync -a --exclude 'run-*.ts' /tmp/ref/src/ ./src/          # labs excluded
cp /tmp/ref/{index.html,vite.config.ts,vitest.config.ts,tsconfig.json,tsconfig.app.json,\
tsconfig.node.json,package.json,bun.lock,eslint.config.js,postcss.config.cjs,.prettierrc,\
.prettierignore,components.json,convex.json,vly-toolbar-readonly.tsx} ./
cp -r /tmp/ref/public ./public
```

`src/convex/_generated/` comes along inside `src/` and must be kept: a clean checkout cannot
typecheck (or run two ported tests) without it.

## 2. Delete what must not be ported

| remove | why |
|---|---|
| the 4 lab-only tests: `advisor-reprice-lab`, `exit-sweep-scaleout`, `ltf-dd-lab`, `ltf5m-short-lab` | they import excluded `run-*` labs |
| `src/lib/luxphase2/{pull-4y,pull-forward,probe-4y}.ts` | they hardcode the reference deployment's relay host |
| `scripts/luxmcp/`, root `mech*.ts`, `probe-loop.ts` | research, not runtime |
| all 62 root `*.md` journals, `.github/`, `.ignore`, every `.env*` | P&L disclosure, CI that targets the old project, secrets |
| the reference `.git` | its history holds the leaked key and personal emails |

Never copy a stored row either: `strategyConfig`, `liveDefaults`, `liveAccount`, `liveTrades`,
`paperTrades` are all created by the deployment from code defaults, not migrated.

## 3. Apply the seven edits

| file | edit | why |
|---|---|---|
| `src/main.tsx` | replace the hardcoded `new ConvexReactClient("https://…convex.cloud")` with `import.meta.env.VITE_CONVEX_URL` + a throw when unset | a pinned host aims gated writes at another deployment |
| `src/convex/crons.ts` | comment out the two `downBlockShadow` cron registrations | that module was never published; an invalid cron target breaks the push |
| `src/pages/Live.tsx` | drop `CoinPriorityCard` + `DownBlockForwardCard` imports and their two blocks | those components were never published |
| `src/pages/Dashboard.tsx` | drop `DownBlockForwardCard` import and block | same |
| `package.json` | remove the 68 scripts whose entry files are `run-*` labs; add `setup:check` | they point at files not in the tree |
| `.gitignore` | add `.env.local`, `.env.deploy`, `data/`, `dist/` | keep keys and cache out of history |
| `.env.example` | names only, no values | documents configuration without leaking it |

## 4. Add the files that do not exist upstream

- `src/convex/tickTiming.ts` — imported by `strategyEngine`, `cronWrappers`, `rLockExit` but never
  committed. Rebuilt against `heartbeat.recordDuration`: measures the tick, returns the body's value
  unchanged, rethrows its errors unchanged.
- `scripts/verify-parity-replay.ts` — the replay harness for verification gate #2.
- `scripts/preflight.ts` — config check (`bun run setup:check`).

## 5. Verify the re-port

```bash
bun install --frozen-lockfile        # expect 434 packages
npx tsc -b                           # expect exit 0
npx vitest run                       # expect 81 files / 1227 tests
sha256sum -c PORT-MANIFEST.sha256 --quiet   # expect no output = every file matches
bun run setup:check                  # expect exit 0 once configured
```

Then replay parity against the reference clone on identical cached bars:

```bash
bun run cache:seed                                                    # or a narrow window
PAIRS=BTC,ETH,SOL bun run scripts/verify-parity-replay.ts             # this tree
cp scripts/verify-parity-replay.ts /tmp/ref/scripts/ && cd /tmp/ref \
  && PAIRS=BTC,ETH,SOL bun run scripts/verify-parity-replay.ts        # reference tree
```

Identical output = the port is equivalent at runtime, not merely textually equal.

## 6. Configuration without a `.env.local`

A `.env.local` file is **optional and often undesirable** — an exported variable cannot be committed
by accident. Both consumers read the environment directly:

```bash
export VITE_CONVEX_URL=https://<your-deployment>.convex.cloud   # Vite inlines it at build time
export CONVEX_DEPLOYMENT=<your-deployment>                      # or CONVEX_DEPLOY_KEY for CI
bun run setup:check && npx vite build
```

`scripts/preflight.ts` checks `process.env` first and only falls back to `.env.local`, so the
no-file path is a supported path, not a workaround. Deployment-side values (`OPERATOR_EMAILS`,
`MEXC_API_KEY`, `MEXC_API_SECRET`, `SITE_URL`, …) are never local files at all — they live on the
Convex deployment via `npx convex env set`.

## 7. What this recipe produced

292 tracked files, 434 packages, `tsc -b` exit 0, 81 test files / 1227 tests passing, and a replay
that matches the reference signal-for-signal on two cached windows. The one gap that no recipe can
close: `src/convex/marketDataNode.ts` (and `downBlockShadow.ts`) were never committed upstream, so
this tree typechecks and tests green but cannot produce signals on a deployment until that file is
restored from the author's working copy. See [PORTING.md](PORTING.md).
