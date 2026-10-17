// Oracle health, as the admin panel computes it.
//
// Written after 2026-10-07: the U/tALGO feed stopped at 16:04Z and nobody knew
// for six and a half hours, during which borrowing and all three liquidation
// paths were reverting on that pool.

import { describe, expect, it, vi } from "vitest";
import algosdk from "algosdk";
import { getActiveOracleId, getOracle, getOracleHealth, getOracleRoles, getOracleSwapState } from "./magnetfiReads";
import { ACTIVE, ACTIVE_ORACLE_POOLS, ACTIVE_POOL_WIRING } from "./magnetfi";

// Keyed off the ORACLE's pool set, which is what getOracleHealth iterates.
// Using POOL_WIRING here passed only by coincidence — the two sets overlap on
// u-talgo — and would not have noticed them diverging, which is the exact bug
// this file now guards.
const POOLS = ACTIVE_ORACLE_POOLS.map((p) => [p.id, p] as const);
const [FIRST_ID, FIRST] = POOLS[0];

const key = (prefix: string, poolId: number) =>
  Buffer.concat([Buffer.from(prefix), Buffer.from(algosdk.encodeUint64(BigInt(poolId)))])
    .toString("base64");

/** An algod whose oracle app returns exactly these per-pool values. */
function fakeAlgod(per: Record<number, { price?: number; anchor?: number; ts?: number }>) {
  const gs: { key: string; value: { type: number; uint: number } }[] = [];
  for (const [pid, v] of Object.entries(per)) {
    const id = Number(pid);
    if (v.price !== undefined) gs.push({ key: key("lp_price_", id), value: { type: 2, uint: v.price } });
    if (v.anchor !== undefined) gs.push({ key: key("lp_anchor_", id), value: { type: 2, uint: v.anchor } });
    if (v.ts !== undefined) gs.push({ key: key("lp_ts_", id), value: { type: 2, uint: v.ts } });
  }
  return { getApplicationByID: () => ({ do: async () => ({ params: { globalState: gs } }) }) } as unknown as algosdk.Algodv2;
}

const NOW = 1_800_000_000;
const at = (secsAgo: number) => NOW - secsAgo;
const withClock = async <T,>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  try { return await fn(); } finally { vi.restoreAllMocks(); }
};
const only = (rows: Awaited<ReturnType<typeof getOracleHealth>>) =>
  rows.find((r) => r.id === FIRST_ID)!;

describe("staleness levels track the vault's own window", () => {
  it("is ok while fresh", async () => {
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(120) } })));
    expect(only(r).level).toBe("ok");
  });

  it("warns at half the window, before anything breaks", async () => {
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(901) } })));
    expect(only(r).level).toBe("warn");
  });

  it("is critical once the vault is actually refusing", async () => {
    // 1800s is ORACLE_FRESHNESS in vault/contract.py. Past it, borrowing and
    // ALL THREE liquidation paths revert.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(1801) } })));
    expect(only(r).level).toBe("critical");
  });

  it("does not call a pool that never posted stale", async () => {
    // ts === 0 means add_pool has not run. Reporting that as a six-hour outage
    // is how an alert stops being believed.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 0, anchor: 0, ts: 0 } })));
    expect(only(r).level).toBe("ok");
    expect(only(r).ts).toBe(0);
  });
});

describe("the band is the leading indicator", () => {
  it("computes ±25% around the anchor", async () => {
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 800_000, ts: at(60) } })));
    const p = only(r);
    expect(p.bandLow).toBeCloseTo(0.6, 6);    // 800_000 × 0.75
    expect(p.bandHigh).toBeCloseTo(1.0, 6);   // 800_000 × 1.25
  });

  it("measures room from the price, not from the anchor", async () => {
    // What matters is how far the PRICE may still move before a post reverts.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 1_000_000, anchor: 1_000_000, ts: at(60) } })));
    const p = only(r);
    expect(p.roomUpPct).toBeCloseTo(25, 4);
    expect(p.roomDownPct).toBeCloseTo(25, 4);
  });

  it("flags a price closing on its ceiling BEFORE it freezes", async () => {
    // The state U/tALGO was in for hours with nothing on screen saying so.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 1_240_000, anchor: 1_000_000, ts: at(60) } })));
    const p = only(r);
    expect(p.level).toBe("ok");        // still posting
    expect(p.nearBand).toBe(true);     // but about to stop
    expect(p.roomUpPct!).toBeLessThan(5);
  });

  it("reports no band when no anchor is set", async () => {
    // anchor 0 disables the on-chain guard; claiming a band would be inventing one.
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 0, ts: at(60) } })));
    const p = only(r);
    expect(p.bandLow).toBeNull();
    expect(p.roomUpPct).toBeNull();
    expect(p.nearBand).toBe(false);
  });
});

describe("pools are reported independently", () => {
  it("one dead feed does not hide behind a healthy one", async () => {
    // 2026-10-07 exactly: one pool posting every five minutes, the other
    // untouched for hours.
    if (POOLS.length < 2) return;
    const [, second] = POOLS[1];
    const r = await withClock(() => getOracleHealth(fakeAlgod({
      [FIRST.poolId]: { price: 900_000, anchor: 870_000, ts: at(23_000) },
      [second.poolId]: { price: 2_480_000, anchor: 2_400_000, ts: at(180) },
    })));
    expect(r.find((x) => x.poolId === FIRST.poolId)!.level).toBe("critical");
    expect(r.find((x) => x.poolId === second.poolId)!.level).toBe("ok");
  });
});

describe("which pools the panel shows", () => {
  it("covers every pool the oracle carries, not just the borrowable ones", async () => {
    // The regression: the panel iterated POOL_WIRING (vault-side), so ALGO/USDC
    // and U/ALGO — registered on the oracle and being posted to — were invisible
    // in the one view whose job is to notice a feed that has stopped.
    const rows = await getOracleHealth(fakeAlgod({}));
    expect(rows).toHaveLength(ACTIVE_ORACLE_POOLS.length);
    for (const p of ACTIVE_ORACLE_POOLS) {
      expect(rows.find((r) => r.poolId === p.poolId)).toBeTruthy();
    }
  });

  it("marks a priced-but-unborrowable pool as not vault-wired", async () => {
    // So an oracle-only pool reads as monitored-but-not-collateral rather than
    // as a collateral vault that has gone quiet.
    const rows = await getOracleHealth(fakeAlgod({}));
    for (const p of ACTIVE_ORACLE_POOLS) {
      const row = rows.find((r) => r.poolId === p.poolId)!;
      expect(row.vaultWired).toBe(p.vaultWired);
      // And vault-wired must agree with the vault-side source of truth.
      expect(row.vaultWired).toBe(p.id in ACTIVE_POOL_WIRING);
    }
  });
});

describe("which oracle the vault is reading", () => {
  /** An algod whose VAULT app returns these globals. */
  function fakeVault(g: Record<string, number>) {
    const gs = Object.entries(g).map(([k, uint]) => ({
      key: Buffer.from(k).toString("base64"),
      value: { type: 2, uint },
    }));
    return {
      getApplicationByID: () => ({ do: async () => ({ params: { globalState: gs } }) }),
    } as unknown as algosdk.Algodv2;
  }

  it("reports the vault's oracle, not the compiled-in constant", async () => {
    // The point of reading from chain: after confirm_lp_oracle the vault moves
    // immediately, while the constant keeps pointing at the old oracle until
    // someone redeploys the frontend.
    const st = await getOracleSwapState(fakeVault({ lp_oracle_app_id: 999_111 }));
    expect(st.activeOracle).toBe(999_111);
    expect(st.driftedFromConstant).toBe(true);
  });

  it("reports no drift when the vault agrees with the constant", async () => {
    const st = await getOracleSwapState(fakeVault({ lp_oracle_app_id: ACTIVE.oracle }));
    expect(st.activeOracle).toBe(ACTIVE.oracle);
    expect(st.driftedFromConstant).toBe(false);
  });

  it("surfaces a queued swap and its eta", async () => {
    const st = await getOracleSwapState(
      fakeVault({ lp_oracle_app_id: ACTIVE.oracle, pending_lp_oracle: 424_242, pending_lp_oracle_eta: 1_800_000_000 }),
    );
    expect(st.pendingOracle).toBe(424_242);
    expect(st.pendingEtaSec).toBe(1_800_000_000);
  });

  it("treats a zero pending oracle as nothing queued", async () => {
    // The vault zeroes pending_lp_oracle on confirm and on cancel, so 0 is the
    // resting state rather than a real app id.
    const st = await getOracleSwapState(
      fakeVault({ lp_oracle_app_id: ACTIVE.oracle, pending_lp_oracle: 0, pending_lp_oracle_eta: 0 }),
    );
    expect(st.pendingOracle).toBeNull();
    expect(st.pendingEtaSec).toBeNull();
  });

  it("falls back to the constant if the vault read yields nothing", async () => {
    // A degraded read must not report oracle 0, which would make the panel
    // query a nonexistent app and show nothing at all.
    const st = await getOracleSwapState(fakeVault({}));
    expect(st.activeOracle).toBe(ACTIVE.oracle);
    expect(st.driftedFromConstant).toBe(false);
  });
});

/**
 * The oracle id is asked of the vault, not assumed.
 *
 * These need an algod that DISTINGUISHES apps. `fakeAlgod` above returns the
 * same global state for every id, so it cannot tell "read the vault's answer"
 * from "read the constant" — a test written on it would pass either way, which
 * is the failure mode this file was rewritten to avoid in the first place.
 */
function routedAlgod(byApp: Record<number, Record<string, number>>) {
  const seen: number[] = [];
  const algod = {
    getApplicationByID: (id: number | bigint) => {
      const n = Number(id);
      seen.push(n);
      const gs = Object.entries(byApp[n] ?? {}).map(([k, uint]) => ({ key: k, value: { type: 2, uint } }));
      return { do: async () => ({ params: { globalState: gs } }) };
    },
  } as unknown as algosdk.Algodv2;
  return { algod, seen };
}

const VAULT_KEY = Buffer.from("lp_oracle_app_id").toString("base64");
const REPOINTED = 424_242;

describe("reads follow the vault's oracle, not the compiled-in constant", () => {
  it("resolves the oracle the vault actually points at", async () => {
    const { algod } = routedAlgod({ [ACTIVE.vault]: { [VAULT_KEY]: REPOINTED } });
    expect(await getActiveOracleId(algod)).toBe(REPOINTED);
  });

  it("reads the PRICE from that oracle, not from ACTIVE.oracle", async () => {
    // The real regression: after a repoint, getOracle must stop serving the
    // retired oracle's price. Both apps carry a price for the same pool and
    // they differ, so the returned number names which one was read.
    const { algod, seen } = routedAlgod({
      [ACTIVE.vault]: { [VAULT_KEY]: REPOINTED },
      [ACTIVE.oracle]: { [key("lp_price_", FIRST.poolId)]: 1_000_000 },
      [REPOINTED]: { [key("lp_price_", FIRST.poolId)]: 2_000_000 },
    });
    const o = await getOracle(algod, FIRST.poolId);
    expect(o.price).toBe(2);
    expect(seen).toContain(REPOINTED);
    expect(seen).not.toContain(ACTIVE.oracle);
  });

  it("lets a caller override, so the panel can watch the PENDING oracle", async () => {
    // A queued oracle is by definition not the vault's yet; monitoring it
    // before the confirm is the whole point of the override.
    const { algod, seen } = routedAlgod({
      [ACTIVE.vault]: { [VAULT_KEY]: REPOINTED },
      [999_999]: { [key("lp_price_", FIRST.poolId)]: 3_000_000 },
    });
    expect((await getOracle(algod, FIRST.poolId, 999_999)).price).toBe(3);
    expect(seen).not.toContain(ACTIVE.vault);   // no needless vault read
  });

  it("falls back to the constant rather than failing the read", async () => {
    // A vault read that throws must not blank the price UI.
    const algod = {
      getApplicationByID: (id: number | bigint) => ({
        do: async () => {
          if (Number(id) === ACTIVE.vault) throw new Error("algod down");
          return { params: { globalState: [] } };
        },
      }),
    } as unknown as algosdk.Algodv2;
    expect(await getActiveOracleId(algod)).toBe(ACTIVE.oracle);
  });

  it("treats an unset vault key as 'use the constant'", async () => {
    const { algod } = routedAlgod({ [ACTIVE.vault]: {} });
    expect(await getActiveOracleId(algod)).toBe(ACTIVE.oracle);
  });
});

/**
 * The other two functions that changed signature.
 *
 * `getOracleHealth` and `getOracleRoles` also went from a defaulted constant to
 * resolving from the vault, and neither had a test for that path — the only
 * existing getOracleHealth coverage runs on `fakeAlgod`, which answers every
 * app id with the same state and so cannot tell the two apart.
 */
function routedAlgodMixed(
  byApp: Record<number, Record<string, { uint?: number; bytes?: string }>>,
) {
  const seen: number[] = [];
  return {
    seen,
    algod: {
      getApplicationByID: (id: number | bigint) => {
        const n = Number(id);
        seen.push(n);
        const gs = Object.entries(byApp[n] ?? {}).map(([key, v]) => ({
          key,
          value: v.bytes !== undefined
            ? { type: 1, bytes: v.bytes, uint: 0 }
            : { type: 2, uint: v.uint ?? 0 },
        }));
        return { do: async () => ({ params: { globalState: gs } }) };
      },
    } as unknown as algosdk.Algodv2,
  };
}

describe("getOracleHealth follows the vault too", () => {
  it("reads health from the repointed oracle, not the constant", async () => {
    const { algod, seen } = routedAlgod({
      [ACTIVE.vault]: { [VAULT_KEY]: REPOINTED },
      [ACTIVE.oracle]: { [key("lp_ts_", FIRST.poolId)]: 111 },
      [REPOINTED]: { [key("lp_ts_", FIRST.poolId)]: 222 },
    });
    const rows = await getOracleHealth(algod);
    expect(rows.find((r) => r.id === FIRST_ID)!.ts).toBe(222);
    expect(seen).not.toContain(ACTIVE.oracle);
  });

  it("still honours an explicit id, for the pending oracle", async () => {
    const { algod, seen } = routedAlgod({
      [777]: { [key("lp_ts_", FIRST.poolId)]: 333 },
    });
    const rows = await getOracleHealth(algod, 777);
    expect(rows.find((r) => r.id === FIRST_ID)!.ts).toBe(333);
    expect(seen).not.toContain(ACTIVE.vault);
  });
});

describe("getOracleRoles follows the vault too", () => {
  it("reads roles from the repointed oracle", async () => {
    const addr = algosdk.decodeAddress(
      "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A").publicKey;
    const b64 = Buffer.from(addr).toString("base64");
    const { algod, seen } = routedAlgodMixed({
      [ACTIVE.vault]: { [VAULT_KEY]: { uint: REPOINTED } },
      [REPOINTED]: { [Buffer.from("admin").toString("base64")]: { bytes: b64 } },
    });
    const roles = await getOracleRoles(algod);
    expect(roles.admin).toBe("KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A");
    expect(seen).toContain(REPOINTED);
  });
});

describe("zero is treated as 'resolve', not as app 0", () => {
  it("resolves from the vault when passed an explicit 0", async () => {
    // The resolver guards with `||` and the consumers used to guard with `??`,
    // so an explicit 0 would have reached getApplicationByID(0) and thrown.
    // ACTIVE.oracle is 0 in the documented pre-deploy shape, which is exactly
    // where a 0 could surface.
    const { algod } = routedAlgod({
      [ACTIVE.vault]: { [VAULT_KEY]: REPOINTED },
      [REPOINTED]: { [key("lp_price_", FIRST.poolId)]: 5_000_000 },
    });
    expect((await getOracle(algod, FIRST.poolId, 0)).price).toBe(5);
  });
});

describe("the fallback announces itself", () => {
  it("warns when the vault read fails, naming both app ids", async () => {
    // The fallback is the remediation for a silent wrong-oracle read, so the
    // signal is the feature. Without this test, deleting the warn is invisible
    // — which is exactly what it is there to prevent.
    const algod = {
      getApplicationByID: () => ({ do: async () => { throw new Error("algod down"); } }),
    } as unknown as algosdk.Algodv2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await getActiveOracleId(algod)).toBe(ACTIVE.oracle);
      expect(warn).toHaveBeenCalledOnce();
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain(String(ACTIVE.vault));
      expect(msg).toContain(String(ACTIVE.oracle));
    } finally { warn.mockRestore(); }
  });

  it("does NOT warn on the ordinary path", async () => {
    const { algod } = routedAlgod({ [ACTIVE.vault]: { [VAULT_KEY]: REPOINTED } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await getActiveOracleId(algod);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
