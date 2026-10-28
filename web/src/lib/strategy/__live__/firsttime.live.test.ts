import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildDeposit, storagePaymentFor, LP_BOX_MBR_MICRO_ALGO } from "@/lib/strategy/pools/group";
import { readMarketGateState, readBalances } from "@/lib/strategy/pools/preflight";
import { verifyOracleSignerPin, signerDriftMessage } from "@/lib/strategy/pex/reads";
import { PEX_ORACLE_SIGNER_PUBKEY_HEX, ORACLE_SIGNER_SOURCES } from "@/lib/strategy/pex/config";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
/** A real funded account with NO `ml2:` box in either market — a first-time LP. */
const FIRST_TIMER = "UFWWEUVQOUO7O5E54SLURIRYDLGUITPU2YBIK6PVDNZGUMZROTTKC5NVHU";

describe("live: a FIRST-TIME depositor", () => {
  it("has no position, so the box does not exist yet", async () => {
    const st = await readMarketGateState(algod, 1, FIRST_TIMER);
    expect(st.shares).toBe(0);
    expect(st.updatedAtSec).toBe(0);
    const bal = await readBalances(algod, FIRST_TIMER);
    console.log(`first-timer: ${(bal.algoSpendableMicro / 1e6).toFixed(3)} ALGO spendable, `
      + `${(bal.usdcMicro / 1e6).toFixed(2)} USDC, opted in ${bal.usdcOptedIn}`);
  }, 90_000);

  it("is REFUSED by MainNet with a zero storage payment", async () => {
    // The bug this test was written to find. AdminOps asserts the payment
    // equals the `ml2:` box MBR exactly:
    //   assert failed pc=1203  opcodes=intc 17 // 26500 ; == ; assert
    // Kept as a test so the first-time shape can never silently regress to
    // zero again — every other live test passes with zero, because every other
    // live test uses a wallet that already has the box.
    await expect(buildDeposit({
      algod, sender: FIRST_TIMER, marketId: 1,
      algoMicro: BigInt(5_000_000), usdcMicro: BigInt(5_000_000),
      storagePaymentMicro: BigInt(0), slippageBps: 100,
    })).rejects.toThrow(/pre-flight check did not pass/);
  }, 90_000);

  it("succeeds once it pays the box MBR", async () => {
    const st = await readMarketGateState(algod, 1, FIRST_TIMER);
    const storagePaymentMicro = storagePaymentFor(st.shares > 0 || st.updatedAtSec > 0);
    expect(storagePaymentMicro).toBe(LP_BOX_MBR_MICRO_ALGO);

    const r = await buildDeposit({
      algod, sender: FIRST_TIMER, marketId: 1,
      algoMicro: BigInt(5_000_000), usdcMicro: BigInt(5_000_000),
      storagePaymentMicro, slippageBps: 100,
    });
    expect(r.assertion.ok).toBe(true);
    const fee = r.txns.reduce((a, t) => a + Number(t.fee), 0);
    console.log(`first deposit: ${r.txns.length} txns, ${fee} µALGO fee, `
      + `${storagePaymentMicro} µALGO box MBR, `
      + `${r.receipt.fields.shares_minted} shares minted`);
  }, 90_000);
});

describe("live: the pinned oracle signer still matches the chain", () => {
  it("agrees with every app that stores it", async () => {
    // The check that would have turned the 2026-10-22 rotation into one
    // sentence instead of a TEAL assert after a wallet prompt.
    const r = await verifyOracleSignerPin(algod);
    if (!r.ok) console.log(signerDriftMessage(r));
    expect(r.drifted).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.onChain).toBe(PEX_ORACLE_SIGNER_PUBKEY_HEX);
    console.log(`signer pin matches chain across `
      + `${ORACLE_SIGNER_SOURCES.length - r.unreadable.length} apps: ${r.onChain?.slice(0, 16)}…`);
  }, 90_000);
});
