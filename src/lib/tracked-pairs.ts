/**
 * The bot's tracked universe — ONE shared source of truth.
 *
 * Imported by BOTH the Convex backend (marketData.ts, the Layer 1 scanner)
 * and the frontend (Layer2Panel's Manual Entry coin picker). A single shared
 * constant means the dropdown can never drift from what the crons actually
 * scan, and the client never needs a Convex round-trip to learn the list.
 *
 * Layer 1 scans 34 pairs (as of the 2026-10-26 prune — see the note below).
 * Trimmed from 29 to 20 on 2026-09-03 (I/O + pair review):
 * Removed: ARB, ENA (blocklisted — entries banned, scanning was pure I/O
 * cost), PEPE, NEAR, FET, FLOKI (0-for-3 closed), OP (-1.39R/6, PF 0.66),
 * GRASS (-0.69R/3), FARTCOIN (breakeven). Kept every positive-R pair from the
 * Sep 2-3 closed-trade review. (ARB/NEAR/FARTCOIN came back in later passes —
 * see below; ENA never did.)
 *
 * The `blocklist` config is a LIVE-ENTRY veto, not a "displayed but
 * untradeable" flag: the paper engine stopped reading it on 2026-10-21 so the
 * measuring book samples every tracked coin, and since 2026-10-26 both stored
 * rows are empty — coin priority (14d paper record) is the only live filter.
 * A tracked pair is scanned by both books; whether it may ENTER is decided by
 * the live engine's gates.
 *
 * On 2026-09-07 the book swapped in two behavior matches for the two worst
 * pair-review coins (kept 20 total):
 *   Removed JTO (-3.18R, 18% WR over 11 closed) and SUI (-1.08R over 8
 *   closed, shorts -3.0R). Added ONDO and ZEC — INJ/TIA-like movers (6.8-9.4% daily range, 26-29%
 *   trend-days) that cleared the 90d book-config check (+104.6R / +102.0R).
 *
 * On 2026-09-11 ARB (+TAO, SUI) were re-added (23 total) — user request.
 *   ARB re-add includes removing it from the config blocklist.
 *
 * On 2026-09-11 PONS + PUMP added (25 total) — user request. MEXC symbols are
 * PONS_USDT and PUMPFUN_USDT ("PUMP_USDT" does not exist on MEXC futures).
 * Both verified serving continuous 15m klines (400+ bar requirement ok).
 *
 * NON-CRYPTO PERPS — gone for good. The six MEXC non-crypto perps (three
 * commodities/stocks added 2026-09-15, three tokenized stock/silver perps
 * added 2026-09-16) were dropped from the universe on 2026-09-26 and are
 * DELETED rather than blocked: no entry in LAYER1_PAIRS, no MEXC alias, no
 * blocklist row, nothing left to resolve. Their measured effect at the time
 * is recorded in PAPER_WEEKLY_2026_W39.md §7 (UBI shift median 0.076/bucket,
 * gate-state flips 3.5%). Era labs pinned before that date still reference
 * the tickers inside their own frozen fixtures (e.g. run-portfolio-gate-lab),
 * which is the only place these strings may appear — era universes must never
 * be re-derived from this mutable list (the live-list alias silently added
 * three of them to the 2026-03→09 era and shifted the layer2 parity anchor
 * 6450→6451t before the fix).
 * `SEP11_25_SNAPSHOT` below is that frozen boundary.
 *
 * On 2026-10-21 TEN PUMP/VIRTUAL-twins added (30 → 40 total) — user request: pairs
 * whose chart movement character matches PUMP + VIRTUAL, all with MEXC
 * maxLeverage ≥ 50 (so 30x is available with headroom) and ≥ $7M 24h flow:
 *   NEAR, QNT, UNI, HBAR, MUU, FIL, DASH, FET, LIT, PENGU.
 * Measured from the live MEXC contract list + 500 closed 15m bars per symbol
 * (2026-10-16 → 10-21). PUMP reference: ATR% 0.961, ER10 0.338, tail 7.08.
 * VIRTUAL reference: ATR% 0.493, ER10 0.312, tail 5.66. Every addition lands
 * inside that band (ATR% 0.51–0.89, ER10 0.30–0.35, tail 5.2–6.9) with 15m
 * return correlation 0.55–0.86 to at least one of the two. Full table and the
 * VERIFICATION block: TRACKED_PAIRS_JOURNAL.md (2026-10-21 section).
 * FIL is tracked under its advertised ticker, so it needs an alias
 * (FILECOIN_USDT) — everything else resolves as `${coin}_USDT`.
 *
 * ENA is deleted outright (2026-10-26, user request): removed from the
 * universe, from both stored blocklists and from DEFAULT_CONFIG.blocklist.
 * Its record (negative in both eras, BAD_ENTRY-concentrated) is history; the
 * coin is not tracked, not scored and not blocked, because it never reaches
 * the engines at all.
 *
 * 2026-10-26 — SIX LAGGARDS DELETED (40 → 34, user request). Ranked on the two
 * windows that actually exist, not on vibes: the paper ledger's 14-day record
 * (the same window the live book's coin ranking reads) and the 22-day
 * trade-mining dump (TRADE_MINING_JOURNAL.md §8, coins with n≥10). Pooled
 * R/trade over both windows, worst first:
 *
 *   INJ   56 closes   −0.061 R/t   37–38% WR   the only coin negative in BOTH
 *                                              windows (14d −1.55R/21n,
 *                                              22d −1.84R/35n); also the single
 *                                              member of the coin-priority
 *                                              `avoid` tier, and the worst long
 *                                              bleeder (−7.14R/7n)
 *   DOT   23 closes   +0.028 R/t   31.6% WR   22d −3.33R/19n — second-worst WR
 *                                              in the universe; its own pair
 *                                              config was never screened
 *                                              (pair-config.ts)
 *   APT   59 closes   +0.116 R/t   39.5% WR   22d −0.58R/38n on the largest
 *                                              sample of the group; 14d was
 *                                              +7.40R/21n, so this is the
 *                                              weakest of the six
 *   TAO   63 closes   +0.139 R/t   41–46% WR   the book's most-traded coin for no
 *                                              edge (14d +0.29R/22n ≈ zero) and
 *                                              the coin-priority doc's own
 *                                              worst-pair example
 *   DASH   1 close    −1.02R                  6 closes since the 2026-10-21 add,
 *                                              $9.8M 24h flow — thinnest of the
 *                                              ten twins, never signals
 *   WLD    1 close    +1.45R                  <10 closes in 22 days and 1 in the
 *                                              last 14: it is scanned every 15m
 *                                              and produces nothing to learn from
 *
 * HONEST BOUND: with sd ≈ 1R, a 56-close sample carries SE ≈ 0.13R, so this is a
 * PRUNE — stop paying scan I/O and stop surfacing their signals — not a proven
 * edge change. It cannot move P&L materially in either direction, and no gate
 * changes with it.
 *
 * What deliberately did NOT change: `SEP11_25_SNAPSHOT` (era freeze — ~60 labs
 * read it) and the per-coin friction/sizing maps (`PAIR_CONFIGS`,
 * `SLIPPAGE_BPS_OVERRIDES`). Those maps already carry untracked coins (PEPE, OP,
 * JTO, GRASS, FLOKI) and are not universes; deleting keys there would change
 * sizing fallbacks (maxLev 50 → 40) for no benefit.
 */
export const LAYER1_PAIRS: string[] = [
  "BTC", "ETH",
  "SOL", "ADA", "JASMY", "PYTH", "WIF", "PENDLE",
  "AVAX", "DOGE", "LINK", "HYPE", "XRP",
  "RENDER", "TIA", "SEI",
  "ONDO", "ZEC",
  "ARB", "SUI",
  "PONS", "PUMP",
  // 2026-10-26: INJ, DOT, APT, TAO and WLD were deleted from the three lines
  // above (SOL/JASMY, AVAX, RENDER/TIA/SEI) — see the header note for the six
  // coins and why.
  // SUI-twin trio (2026-09-26, user request): the three untracked perps that
  // best matched SUI — the week's top performer (+15.97R / +0.614 R/t) — on
  // 30d return-correlation (≥0.62), trend persistence (ER10 in SUI's band)
  // and ATR% in SUI's band, each with ≥$6M 24h flow. Measured from the live
  // MEXC ticker list; see the probe note in the header.
  "VIRTUAL", "SHIB", "FARTCOIN",
  // PUMP/VIRTUAL-twins (2026-10-21, user request) — see the header note for the
  // measured band. Ordered by 24h flow at the time of the probe.
  // 2026-10-26: DASH deleted from this list (thinnest flow of the ten and one
  // close in the 14-day ledger).
  "NEAR", "QNT", "UNI", "HBAR", "MUU", "FIL", "FET", "LIT", "PENGU",
  // 2026-09-26: the non-crypto bloc (USOIL/XAU/TESLA added 09-15; SPCX/NVDA/XAG
  // added 09-16) was REMOVED at the user's request. It measurably shifted UBI
  // (median 0.076/bucket, gate-state flips in 3.5% of buckets) and SPCX bled
  // in the book (−2.64R); see PAPER_WEEKLY_2026_W39.md §7.
];

/**
 * PAIRS BARRED FROM LIVE ENTRIES — the live book's universe is LAYER1_PAIRS
 * minus this list. (2026-10-25, user decision.)
 *
 * BTC: it is the live book's regime INPUT, not a tradable in it. Its 4h EMA75
 * slope decides whether every other pair may enter, so a BTC position would be
 * judged by the reading it helps produce, and every alt already carries BTC
 * beta (that is what maxNetBtcBeta nets out) — a BTC position double-counts it.
 * PAPER keeps scanning and trading BTC: the paper ledger is the measurement
 * instrument, and its BTC rows are part of the record the gates were fitted on.
 * Enforced in liveBrokerRuntime twice: the scan list (no klines spent on it)
 * and processPairLive (the only function that can spend live money).
 */
export const LIVE_EXCLUDED_PAIRS: readonly string[] = ["BTC"];

/** True when `pair` may be ENTERED by the live book. Reads the exclusion list,
 *  so removing a coin from it re-admits that coin with no other edit. */
export function isLiveTradable(pair: string): boolean {
  return !LIVE_EXCLUDED_PAIRS.includes(String(pair).toUpperCase());
}

/**
 * ERA UNIVERSE FREEZE — the 25 tracked pairs exactly as of the 2026-09-11
 * boundary (SEP03_20 + ARB/TAO/SUI re-add + PONS/PUMP). Era labs must import
 * THIS, never LAYER1_PAIRS: the live list is mutable (user adds like the
 * 2026-09-15 non-crypto trio), and a live-list alias retroactively rewrites
 * every era cohort and parity anchor. Add new pairs ONLY to LAYER1_PAIRS.
 */
export const SEP11_25_SNAPSHOT: readonly string[] = [
  "SOL", "ADA", "INJ", "JASMY", "PYTH", "WIF", "PENDLE",
  "AVAX", "DOT", "DOGE", "LINK", "HYPE", "XRP",
  "RENDER", "TIA", "APT", "SEI", "WLD",
  "ONDO", "ZEC",
  "ARB", "TAO", "SUI",
  "PONS", "PUMP",
];

/** Coin -> MEXC futures symbol when it differs from `${coin}_USDT`. */
export const MEXC_SYMBOL_ALIASES: Record<string, string> = {
  PUMP: "PUMPFUN_USDT",
  // 2026-10-21: MEXC lists Filecoin's perp as FILECOIN_USDT, not FIL_USDT.
  FIL: "FILECOIN_USDT",
  // Tokenized stock/metal perps REMOVED 2026-09-26 (their aliases stayed
  // accurate while listed; the pairs are no longer tracked).
};

/** Coin -> MEXC futures symbol (alias-aware). */
export function toMexcSymbol(coin: string): string {
  return MEXC_SYMBOL_ALIASES[coin] ?? `${coin}_USDT`;
}

/** MEXC futures symbol -> internal coin id (reverse alias). Unknown symbols
 *  get the naive base ("FOO_USDT" -> "FOO"); aliased ones map back
 *  ("PUMPFUN_USDT" -> "PUMP"). Used by the batch ticker, which returns
 *  exchange symbols, to key results by the coin ids the rest of the app uses. */
export function fromMexcSymbol(symbol: string): string {
  for (const [coin, mexc] of Object.entries(MEXC_SYMBOL_ALIASES)) {
    if (mexc === symbol) return coin;
  }
  return symbol.replace(/_USDT$/, "");
}
