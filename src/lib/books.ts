/**
 * PAPER BOOK IDENTIFIERS — one source of truth.
 *
 * A book tag is the join key for the whole paper ledger: `paperTrades.book`,
 * `bookStats.book`, and `paperAccount.name`. Two modules need the same literal
 * — convex/paperTrading.ts (insertTrade's dedupe + open-position lock, the
 * close path that decides whose balance to credit, and the per-book stats
 * fold) and the engine that writes the rows — and if they ever disagreed the
 * failure would be SILENT: trades land under a tag whose account and stats doc
 * don't exist, so P&L is credited nowhere and the book's header reads zero
 * forever.
 *
 * That is the same shape of bug as the 2026-09-12 audit finding in reset.ts
 * (a value that must agree across modules, duplicated as a literal). Declared
 * once here instead.
 *
 * 2026-09-26: the proxy and confluence books were removed. Layer2 is now the
 * only book, and the tag stays a named constant because the failure mode above
 * is unchanged.
 */

/** The EMA-momentum book: convex/strategyEngine.ts. */
export const LAYER2_BOOK = "layer2";

/**
 * The A+ book — the SAME signal stack as layer2, filtered to one setup.
 *
 * It is deliberately NOT a second strategy: it reuses layer2's scan, gates,
 * sizing and exit bracket so the only difference between the two books is the
 * entry filter (src/lib/a-plus-filter.ts). That makes the pair a controlled
 * A/B — whatever the A+ book does differently is attributable to the filter
 * and nothing else.
 *
 * It exists to FORWARD-TEST one rule that cleared both bars on the 12-day
 * paper window (bun run lab:paperquality): keep only LONGs whose recorded
 * shortScore is at or below a frozen threshold — i.e. enter long only when the
 * bot's own short case is emphatically rejected. That is a PAPER instrument.
 * It is not armed on the live engine, and the threshold is fitted and frozen,
 * so the only honest verdict is the forward record this book accumulates.
 */
export const A_PLUS_BOOK = "aplus";

/**
 * 2026-10-29: the short-only entry book was DELETED (modules, tables, panel and
 * its paperAccount queries). It is deliberately absent from STATS_BOOKS — a tag
 * with no registry entry is the exact silent-credit bug this file guards.
 */

/** Every book that maintains its own bookStats doc (see foldBookStats). */
export const STATS_BOOKS: readonly string[] = [LAYER2_BOOK, A_PLUS_BOOK];
