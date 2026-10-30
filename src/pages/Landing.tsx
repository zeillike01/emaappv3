import { motion } from "framer-motion";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/GlassPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LAYER1_PAIRS } from "@/lib/tracked-pairs";
import {
  TrendingUp,
  Shield,
  BarChart3,
  Zap,
  ArrowRight,
  Activity,
  Target,
  Layers,
} from "lucide-react";

const features = [
  {
    icon: <TrendingUp className="size-5" />,
    title: "EMA Break + Structure Entries",
    description:
      "Longs need a close above the fast EMA and a confirmed Higher Low; shorts mirror with a Lower High. No retest required — structure alone confirms the entry.",
  },
  {
    icon: <Shield className="size-5" />,
    title: "Higher-Timeframe Trend Filter",
    description:
      "A 4H EMA gate blocks every counter-trend signal before it fires — no longs below the higher-timeframe EMA, no shorts above it.",
  },
  {
    icon: <Layers className="size-5" />,
    title: "Layer 2 EMA Momentum",
    description:
      "A second book scores EMA momentum, order-book imbalance, trade flow, funding and spread on live market data — 15m candle closes only.",
  },
  {
    icon: <Target className="size-5" />,
    title: "Ratcheted Profit Locking",
    description:
      "Winners lock in as they run: the trailing ratchet protects gains from 2R up to the 8R target instead of giving them back.",
  },
  {
    icon: <Zap className="size-5" />,
    title: "Live MEXC Market Data",
    description:
      `Real USDT-perpetual order books, trades, funding and candles across ${LAYER1_PAIRS.length} pairs — server-side, refreshed continuously by crons.`,
      // NOTE: the tracked universe (LAYER1_PAIRS) is the single source of truth
      // for this count — trimmed 29 → 20 on 2026-09-03.
  },
  {
    icon: <BarChart3 className="size-5" />,
    title: "Full Performance Audit",
    description:
      "Every simulated trade logs entry, exit, R-multiple, fees, funding and market context. Review win rate, PnL and drawdown per book and per pair.",
  },
];

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
};

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Background gradient orbs with fluid liquid lighting */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-44 -right-36 size-[560px] rounded-full bg-gradient-to-br from-sky-400/18 via-cyan-300/12 to-indigo-300/10 blur-[90px]" />
        <div className="absolute top-1/3 -left-24 size-[440px] rounded-full bg-gradient-to-tr from-indigo-400/16 via-blue-300/10 to-teal-200/8 blur-[90px]" />
        <div className="absolute bottom-0 right-1/4 size-[380px] rounded-full bg-gradient-to-tl from-emerald-400/14 via-sky-200/8 to-transparent blur-[80px]" />
      </div>

      {/* Content */}
      <div className="relative z-10">
        {/* Nav */}
        <nav className="flex items-center justify-between px-6 py-4 md:px-10">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl border border-sky-400/40 bg-gradient-to-br from-sky-400/20 via-white/30 to-indigo-500/20 text-sky-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_8px_20px_-6px_rgba(14,165,233,0.25)] backdrop-blur-xl">
              <TrendingUp className="size-5" />
            </div>
            <span className="text-lg font-extrabold tracking-tight text-slate-900">
              Trading Bots
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button
              onClick={() => navigate("/auth")}
              className="rounded-xl border border-sky-400/40 bg-gradient-to-r from-sky-500 to-indigo-600 px-5 text-sm font-semibold text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.35),0_8px_22px_-6px_rgba(14,165,233,0.4)] hover:from-sky-600 hover:to-indigo-700 transition-all"
            >
              Open Dashboard
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          </div>
        </nav>

        {/* Hero */}
        <section className="px-6 pt-16 pb-20 md:pt-28 md:pb-32">
          <div className="mx-auto max-w-3xl text-center">
            <motion.div {...fadeUp} transition={{ delay: 0.1 }}>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 backdrop-blur-sm">
                <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Paper Trading Bots Online
              </span>
            </motion.div>

            <motion.h1
              {...fadeUp}
              transition={{ delay: 0.2 }}
              className="mt-6 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl md:text-6xl leading-[1.1]"
            >
              Rules-Based Crypto Bots,
              <br />
              <span className="bg-gradient-to-r from-sky-600 to-indigo-600 bg-clip-text text-transparent">
                Validated on Live Data
              </span>
            </motion.h1>

            <motion.p
              {...fadeUp}
              transition={{ delay: 0.3 }}
              className="mx-auto mt-5 max-w-xl text-base text-slate-500 leading-relaxed md:text-lg"
            >
              Two engines — paper and live — trade live MEXC USDT-perpetual
              data around the clock with the same coded rules. Paper risks no
              funds while you watch the signals and tune the parameters; the
              live engine is ready to place real orders from its own page.
            </motion.p>

            <motion.div
              {...fadeUp}
              transition={{ delay: 0.4 }}
              className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center"
            >
              <Button
                onClick={() => navigate("/auth")}
                size="lg"
                className="rounded-full bg-gradient-to-r from-sky-500 to-indigo-600 px-8 text-sm font-semibold text-white shadow-xl shadow-sky-500/25 hover:from-sky-600 hover:to-indigo-700"
              >
                Open the Bots
                <ArrowRight className="ml-2 size-4" />
              </Button>
              <Button
                onClick={() => navigate("/auth")}
                variant="outline"
                size="lg"
                className="rounded-full border-slate-200 bg-white/50 px-8 text-sm font-medium text-slate-700 backdrop-blur-sm hover:bg-white/70"
              >
                View the Dashboard
              </Button>
            </motion.div>
          </div>

          {/* Hero glass card preview */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.7 }}
            className="mx-auto mt-14 max-w-4xl"
          >
            <GlassPanel className="p-1.5" hover>
              <div className="rounded-2xl bg-gradient-to-br from-white/70 to-white/40 p-5 backdrop-blur-xl">
                <div className="flex items-center gap-2 mb-4">
                  <span className="size-2 rounded-full bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.5)]" />
                  <span className="size-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)]" />
                  <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
                  <span className="ml-2 font-mono text-[11px] font-medium text-slate-400">
                    Layer 2 Book · SOL · Live MEXC data
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-white/60 bg-white/60 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-md">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      Balance
                    </p>
                    <p className="mt-1 font-mono text-lg font-bold text-slate-900 tracking-tight">
                      $162.40
                    </p>
                    <span className="text-[10px] font-semibold text-emerald-600">
                      +8.3% realized
                    </span>
                  </div>
                  <div className="rounded-xl border border-white/60 bg-white/60 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-md">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      Entry Signal
                    </p>
                    <p className="mt-1 font-mono text-lg font-bold text-slate-900 tracking-tight">
                      EMA 7×30
                    </p>
                    <span className="text-[10px] font-semibold text-violet-600">
                      Momentum + flow confirm
                    </span>
                  </div>
                  <div className="rounded-xl border border-emerald-300/50 bg-emerald-500/10 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-md">
                    <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">
                      Signal
                    </p>
                    <p className="mt-1 font-mono text-lg font-bold text-emerald-700 tracking-tight">
                      LONG
                    </p>
                    <span className="text-[10px] font-semibold text-emerald-600">
                      4H EMA confirms
                    </span>
                  </div>
                </div>

                {/* Fake chart area */}
                <div className="mt-4 h-24 rounded-xl border border-white/40 bg-gradient-to-r from-sky-100/60 via-blue-50/30 to-indigo-100/60 flex items-end px-3 pb-2 gap-[3px]">
                  {[40, 55, 45, 60, 50, 65, 55, 70, 60, 75, 65, 80, 70, 85, 75, 60, 70, 80, 85, 90, 80, 85, 88, 92].map(
                    (h, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-sm bg-gradient-to-t from-sky-400/70 to-indigo-400/50"
                        style={{ height: `${h}%` }}
                      />
                    ),
                  )}
                </div>
              </div>
            </GlassPanel>
          </motion.div>
        </section>

        {/* Features */}
        <section className="px-6 pb-20">
          <div className="mx-auto max-w-5xl">
            <div className="text-center mb-12">
              <h2 className="text-2xl font-bold text-slate-800 sm:text-3xl">
                Every rule is coded. No discretion.
              </h2>
              <p className="mt-2 text-sm text-slate-500 max-w-lg mx-auto">
                Both books run exactly as written — entry logic, structure
                detection, and trend filters are all deterministic. You watch
                the output and review every trade.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f, i) => (
                <motion.div
                  key={f.title}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + i * 0.08 }}
                >
                  <GlassPanel className="p-5 h-full" hover>
                    <div className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-sky-100 to-indigo-100 text-sky-600 mb-3">
                      {f.icon}
                    </div>
                    <h3 className="text-sm font-semibold text-slate-800">
                      {f.title}
                    </h3>
                    <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
                      {f.description}
                    </p>
                  </GlassPanel>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-20">
          <GlassPanel className="mx-auto max-w-3xl p-8 text-center md:p-12">
            <h2 className="text-2xl font-bold text-slate-800 sm:text-3xl">
              Watch the bots trade
            </h2>
            <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
              Sign in to watch the Layer 2 paper bot trade live MEXC data —
              open positions, closed trades, realized PnL and every logged
              signal — then arm the same bot on the Live page when you are
              ready for real orders.
            </p>
            <Button
              onClick={() => navigate("/auth")}
              size="lg"
              className="mt-6 rounded-full bg-gradient-to-r from-sky-500 to-indigo-600 px-8 text-sm font-semibold text-white shadow-xl shadow-sky-500/25 hover:from-sky-600 hover:to-indigo-700"
            >
              Launch Dashboard
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </GlassPanel>
        </section>

        {/* Footer */}
        <footer className="border-t border-white/20 bg-white/20 backdrop-blur-sm px-6 py-6">
          <div className="mx-auto max-w-5xl flex flex-col items-center gap-2 text-center">
            <div className="flex items-center gap-2">
              <div className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600">
                <TrendingUp className="size-3 text-white" />
              </div>
              <span className="text-sm font-semibold text-slate-700">
                Trading Bots
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Paper trading simulation on MEXC market data. Not financial advice.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
