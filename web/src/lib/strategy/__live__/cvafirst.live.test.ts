/**
 * A FIRST-TIME C-Vault depositor, simulated against MainNet.
 *
 * ── Why this test is the priority for the C-Vault ──
 * The direct pools shipped with the storage payment hardcoded to zero. That is
 * correct for a wallet that already holds an `ml2:` box and WRONG for every new
 * depositor — AdminOps asserts the payment equals the box MBR exactly — so no
 * new depositor could deposit while every test passed, because every test used
 * a wallet that already had the box. It reached production and the first real
 * user hit it (see SIGNING.md §11.10).
 *
 * The C-Vault has the identical trap at a different value: its `gu2:` box MBR
 * is 32,900 µALGO against the pool's 26,500. `cvaStoragePaymentFor` exists and
 * a unit test pins both constants — but until now nothing had simulated a
 * wallet WITHOUT a `gu2:` box through the deposit, which is precisely the hole
 * the pool bug lived in.
 *
 * So this asserts both directions, as the pool test does: refused with a zero
 * payment, accepted once it pays the MBR.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { readCvaSnapshot, readCvaUserShares } from "../cvaSnapshot";
import { buildCvaDeposit, cvaStoragePaymentFor, CVA_USER_BOX_MBR_MICRO_ALGO } from "../cvaGroup";
import { readBalances } from "../preflight";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/**
 * A real funded account with NO `gu2:` box — a PEX trader who has never
 * entered the vault. 2,111 ALGO spendable and 18.78 USDC when chosen.
 */
const FIRST_TIMER = "6UE6PHOA6234L5HTVRMJGN7TKLGCTVLLFTI5DMWUUHJ6OZFGPXFE7QQENU";

describe("live: a first-time C-Vault depositor", () => {
  it("genuinely has no vault position yet", async () => {
    expect(await readCvaUserShares(algod, FIRST_TIMER)).toBeNull();
    const bal = await readBalances(algod, FIRST_TIMER);
    expect(bal.usdcOptedIn).toBe(true);
    console.log(`first-timer: ${(bal.algoSpendableMicro / 1e6).toFixed(3)} ALGO spendable, `
      + `${(bal.usdcMicro / 1e6).toFixed(2)} USDC, no gu2: box`);
  }, 120_000);

  it("is REFUSED with a zero storage payment", async () => {
    // The pool's production bug, in the vault's place. Kept as an assertion so
    // the branch cannot regress to a hardcoded zero unnoticed.
    const snapshot = await readCvaSnapshot(algod);
    await expect(buildCvaDeposit({
      algod, sender: FIRST_TIMER, snapshot,
      algoMicro: BigInt(0), usdcMicro: BigInt(6_000_000),
      storagePaymentMicro: BigInt(0),
      slippageBps: 100,
    })).rejects.toThrow(/pre-flight check did not pass|safety check/);
  }, 120_000);

  it("succeeds once it pays the gu2: box MBR", async () => {
    const snapshot = await readCvaSnapshot(algod);
    const held = await readCvaUserShares(algod, FIRST_TIMER);
    const storagePaymentMicro = cvaStoragePaymentFor(held !== null);
    // The rule under test: a first-timer pays exactly the MBR.
    expect(storagePaymentMicro).toBe(CVA_USER_BOX_MBR_MICRO_ALGO);

    const r = await buildCvaDeposit({
      algod, sender: FIRST_TIMER, snapshot,
      algoMicro: BigInt(0), usdcMicro: BigInt(6_000_000),
      storagePaymentMicro,
      slippageBps: 100,
    });
    expect(r.assertion.ok).toBe(true);
    const minted = r.receipt.fields.cva_shares_minted ?? r.receipt.fields.shares_minted;
    expect(minted).toBeGreaterThan(BigInt(0));
    console.log(`first C-Vault deposit: $6 USDC -> ${minted} shares, `
      + `${r.txns.length} txns, ${r.txns.reduce((a, t) => a + Number(t.fee), 0)} µALGO fee, `
      + `${storagePaymentMicro} µALGO box MBR`);
    console.log("checks:", r.assertion.checked);
  }, 120_000);
});
