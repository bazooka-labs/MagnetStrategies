"use client";

// Runs the shared preflight once on mount and reports whether opens are allowed.
//
// The point of doing it here rather than only in the write path is that the
// button should be honest. A user who fills in an amount, picks a target and
// clicks, only to be told the exchange was upgraded, has been misled by the
// screen for as long as they were looking at it.
//
// The write path checks again regardless — see perpsClient. This gate makes the
// card truthful; that one makes it safe.

import { useCallback, useEffect, useState } from "react";
import algosdk from "algosdk";
import { ALGOD_URLS } from "@/lib/constants";
import { preflight, type PreflightResult } from "@/lib/perpsPreflight";

export function usePerpsPreflight() {
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [tick, setTick] = useState(0);

  const recheck = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setChecking(true);
    const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");
    // `force` on a retry only: the first run should take the cache if another
    // mount already warmed it.
    preflight(algod, tick > 0)
      .then((r) => { if (alive) setResult(r); })
      .catch((e) => {
        // `preflight` resolves rather than rejects for the failures it knows
        // about, so landing here means something unexpected. Still fail closed.
        if (!alive) return;
        setResult({
          canOpen: false,
          reason: "Could not verify the exchange contracts. Check your connection and try again.",
          detail: e instanceof Error ? e.message : String(e),
          checkedAt: Date.now(),
        });
      })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [tick]);

  return {
    /**
     * Opens are permitted. **Null while the first check is in flight** — the
     * caller must treat that as "not yet", never as "yes": the whole purpose is
     * to refuse until the programs have been verified.
     */
    canOpen: result ? result.canOpen : null,
    reason: result?.reason ?? null,
    checking,
    recheck,
  };
}
