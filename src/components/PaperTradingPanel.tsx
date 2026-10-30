/**
 * PaperTradingPanel — the paper (Layer 2) trading surface of /dashboard.
 *
 * Pure tab host: "Trades" (live stats, open positions, closed ledger,
 * signal feed) and "Advanced Data" (on-demand analytics). Both tabs read
 * book="layer2" rows — see Layer2Panel for the I/O contract.
 */
import { Layer2Panel } from "@/components/Layer2Panel";

export function PaperTradingPanel() {
  return <Layer2Panel />;
}
