/**
 * Risk parameters that the CONTRACT will accept but the maths will not.
 *
 * `set_liq_threshold` asserts `<= 9000`. The tiered liquidation is calibrated
 * for 7500 and nothing else: TIER1_SEIZE_BPS/TIER2_SEIZE_BPS are compile-time
 * constants at 35%/77%, chosen so a partial liquidation restores HF >= 1.06,
 * and that holds only at 7500 (audit finding M1, LIQUIDATION.md:483,
 * VAULT.md:26). Set 7800 and every transaction still succeeds — the health
 * restoration just quietly stops working.
 *
 * So the gap between "the chain accepts it" and "it is correct" is 1500 bps
 * wide and completely silent. ALGO/USDC sat at 7800 in this file from when it
 * was drafted until 2026-10-17, and was caught the day it was going to be
 * written on chain. These bind the cap so the next one is caught by CI.
 *
 * Asserted against the exported VALUES, not the source text — a comment saying
 * "7500" would satisfy a grep while the constant said otherwise.
 */
import { describe, expect, it } from "vitest";
import { VAULT_TYPES, ACTIVE_POOL_WIRING, ACTIVE_ORACLE_POOLS } from "./magnetfi";

/** LIQUIDATION.md:483 — "75% — firm cap for every pool". */
const M1_CAP_BPS = 7500;

describe("the M1 liquidation-threshold cap", () => {
  it("holds for every vault type, live or not", () => {
    // Not just the wired ones: an unwired type is a value someone will later
    // copy onto the chain, which is precisely how 7800 nearly shipped.
    for (const v of VAULT_TYPES) {
      expect(v.liqThresholdBps, `${v.id} liquidation threshold`).toBeLessThanOrEqual(M1_CAP_BPS);
    }
  });

  it("keeps LTV strictly below the threshold, as set_ltv asserts", () => {
    // The contract reverts otherwise ("LTV must be below liquidation
    // threshold"), so a violation here is a vault that cannot be wired.
    for (const v of VAULT_TYPES) {
      expect(v.ltvBps, `${v.id} LTV`).toBeGreaterThan(0);
      expect(v.ltvBps, `${v.id} LTV vs threshold`).toBeLessThan(v.liqThresholdBps);
    }
  });

  it("keeps every rate inside the contract's 30% cap", () => {
    for (const v of VAULT_TYPES) {
      expect(v.rateBps, `${v.id} rate`).toBeLessThanOrEqual(3_000);
    }
  });
});

describe("the four live vaults", () => {
  it("wires exactly the pools whose oracle entry says they are wired", () => {
    // Two sources of truth that must agree: POOL_WIRING gates interaction,
    // ACTIVE_ORACLE_POOLS.vaultWired drives the admin oracle panel.
    const wired = new Set(Object.keys(ACTIVE_POOL_WIRING));
    for (const p of ACTIVE_ORACLE_POOLS) {
      expect(wired.has(p.id), `${p.id} wiring vs vaultWired flag`).toBe(p.vaultWired);
    }
  });

  it("gives every wired pool a VaultType to render", () => {
    // poolWiring() decides live-vs-pending, but the card still needs a type;
    // a wired pool with no VaultType silently disappears from the page.
    for (const id of Object.keys(ACTIVE_POOL_WIRING)) {
      expect(VAULT_TYPES.some((v) => v.id === id), `VaultType for ${id}`).toBe(true);
    }
  });

  it("uses the same id for poolId and lpAsaId on every wired pool", () => {
    // True for all four on mainnet: the Tinyman pool's LP ASA id doubles as
    // the vault's pool_id. Worth pinning — they are entered by hand in the
    // admin panel and a transposition would be invisible.
    for (const [id, w] of Object.entries(ACTIVE_POOL_WIRING)) {
      expect(w.poolId, `${id} poolId/lpAsaId`).toBe(w.lpAsaId);
    }
  });
});
