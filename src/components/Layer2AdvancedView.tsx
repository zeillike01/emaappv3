/**
 * Layer2AdvancedView — the "Advanced Data" tab.
 *
 * This is the ONLY component that subscribes to the full layer2 book, and it
 * is mounted only while the tab is open (see Layer2Panel). That makes the
 * always-on Trades tab free of full-book reads: deep analytics is an explicit,
 * on-demand action instead of a standing 239+ row subscription.
 */
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Layer2DataPanel } from "@/components/Layer2DataPanel";

export function Layer2AdvancedView() {
  const trades = useQuery((api as any).paperTrading.getLayer2Trades);
  // undefined = first result in flight → keep the panel's loading state honest
  // (never show "no data" for an in-flight or missing fetch).
  return (
    <Layer2DataPanel
      trades={trades === undefined ? null : (trades as any[])}
      loading={trades === undefined}
    />
  );
}
