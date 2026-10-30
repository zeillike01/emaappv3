import { afterEach, describe, expect, it, vi } from "vitest";
import { createGate, createPacer } from "../mexc/rate-gate";

/**
 * The pacer is the only thing standing between a 40-pair tick and MEXC's
 * aggregate burst limit (measured 2026-10-21: 40 klines at 6-way concurrency
 * → 14 refusals; the same 40 spaced to ~11/s → 0). These tests pin the two
 * properties that make that true: a hard in-flight ceiling and dispatch
 * spacing, plus the guarantee that a throwing request cannot leak a slot.
 */
describe("createPacer", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("never exceeds the in-flight ceiling and spaces dispatches", async () => {
    const GAP = 20;
    const pacer = createPacer(2, GAP);
    let inflight = 0;
    let maxInflight = 0;
    const at: number[] = [];

    globalThis.fetch = (async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      at.push(Date.now());
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    await Promise.all(Array.from({ length: 8 }, (_, i) => pacer.fetch(`https://example.test/${i}`)));
    const wall = Date.now() - t0;

    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(pacer.dispatched).toBe(8);
    // 8 dispatches at 20ms spacing can finish no earlier than 7 gaps.
    expect(wall).toBeGreaterThanOrEqual(GAP * 7 * 0.8);
    const sorted = [...at].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(GAP * 0.8);
    }
  });

  it("releases the slot when a request throws, so the gate cannot deadlock", async () => {
    const pacer = createPacer(1, 1);
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("boom")) throw new Error("network down");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(pacer.fetch("https://example.test/boom")).rejects.toThrow("network down");
    const ok = await pacer.fetch("https://example.test/ok");
    expect(ok.status).toBe(200);
    expect(pacer.dispatched).toBe(2);
  });

  it("aborts a request that never answers instead of holding the slot forever", async () => {
    // The gate is module-level (MEXC limits are per IP), so a hung connection
    // that kept its slot would eventually wedge every later read in the
    // isolate. The timeout is what guarantees the slot comes back.
    const pacer = createPacer(1, 1, 25);
    let sawSignal = false;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sawSignal = init?.signal != null;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    await expect(pacer.fetch("https://example.test/hang")).rejects.toBeTruthy();
    expect(sawSignal).toBe(true);

    // The slot is free again: a healthy call goes straight through.
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const ok = await pacer.fetch("https://example.test/after");
    expect(ok.status).toBe(200);
  });

  it("createGate bounds any task fan-out, not just fetches", async () => {
    // The paper/Layer-1 ticks fan out through ctx.runAction, one execution per
    // relay call, so the fetch pacer cannot see them. The caller-side gate is
    // what bounds that fan-out; these are its two guarantees.
    const gate = createGate(2, 10);
    let inflight = 0;
    let maxInflight = 0;
    const done = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        gate(async () => {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((r) => setTimeout(r, 5));
          inflight--;
          return i;
        }),
      ),
    );
    expect(done).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInflight).toBeLessThanOrEqual(2);
  });

  it("createGate frees the slot when a task throws", async () => {
    const gate = createGate(1, 1);
    await expect(gate(async () => Promise.reject(new Error("relay down")))).rejects.toThrow(
      "relay down",
    );
    await expect(gate(async () => "ok")).resolves.toBe("ok");
  });

  it("respects a caller-supplied signal instead of replacing it", async () => {
    const pacer = createPacer(1, 1, 10_000);
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      received = init?.signal ?? undefined;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    await pacer.fetch("https://example.test/own", { signal: controller.signal });
    expect(received).toBe(controller.signal);
  });
});
