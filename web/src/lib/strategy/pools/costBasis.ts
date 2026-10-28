import algosdk from "algosdk";
import { PEX_APPS } from "@/lib/strategy/pex/config";
import { CVA_SELECTORS } from "./cvaGroup";

/**
 * What a depositor actually paid, read from their own deposit receipts.
 *
 * ── Why this exists ──
 * The card shows "Your position: $25.32". A depositor's next question is
 * always "against what?", and the share price cannot answer it: a position's
 * percentage return is IDENTICAL to the share price's, so quoting the share
 * price tells them nothing they do not already see.
 *
 * The one thing a real position knows that no published series does is **what
 * it cost** — the 0.2% entry spread, and on exit the 0.2% burn spread. On a
 * $25.00 deposit that spread is $0.05, which is a fifth of the first week's
 * gain. A return measured from the post-spread value would quietly hide it.
 *
 * ── The basis is what left the wallet ──
 * Field 4 of the `v2_cva_deposited` receipt, verified against chain: the
 * 2026-10-23 deposit logs 25_000_000 and the group transfers exactly
 * 25.000000 USDC. Not the credited value, not the share price at entry.
 *
 * The 32,900 µALGO box MBR paid alongside is deliberately NOT counted — it is
 * a refundable deposit returned when the box is deleted on full exit, so
 * treating it as cost would overstate what the position actually cost to hold.
 */
export type CostBasis = {
  /** Total USD paid across all deposits. */
  paidUsd: number;
  /** Shares those deposits minted, for the consistency check. */
  shares: number;
  /** How many deposits it came from — 1 for every current holder. */
  deposits: number;
};

/** Receipt field index carrying the deposit's USD value. */
const DEPOSIT_VALUE_FIELD = 4;
/** Receipt field index carrying the shares minted. */
const DEPOSIT_SHARES_FIELD = 5;

const fieldsOf = (log: string | Uint8Array): number[] => {
  const raw = typeof log === "string" ? Buffer.from(log, "base64") : Buffer.from(log);
  // 4-byte ABI return prefix + 2-byte length, then uint64s.
  const body = raw.subarray(6);
  const out: number[] = [];
  for (let i = 0; i + 8 <= body.length; i += 8) out.push(Number(body.readBigUInt64BE(i)));
  return out;
};

/**
 * Read the caller's cost basis, or null when it cannot be trusted.
 *
 * ── How it handles a history with withdrawals ──
 * It does NOT try to do withdrawal accounting. It asks a narrower question
 * that needs none: **what did the shares you hold right now cost?**
 *
 * Deposits are walked newest-first and accumulated until their minted shares
 * equal the shares actually held. If the held balance matches a suffix of the
 * deposit history exactly, those deposits are the position and their total is
 * the basis. A wallet that deposited $7, exited fully, then deposited $25 is
 * the common case and resolves cleanly to $25.
 *
 * Anything that does not reconcile — a partial exit leaving a balance that
 * matches no suffix, a missing receipt, a gap — returns null. Showing a return
 * against a basis we are not sure of would overstate or understate it, and
 * there is no version of that which is acceptable on a money surface.
 */
export async function readCostBasis(
  indexer: algosdk.Indexer, address: string, sharesHeld: number,
): Promise<CostBasis | null> {
  if (sharesHeld <= 0) return null;
  try {
    const res = await indexer
      .searchForTransactions()
      .address(address)
      .applicationID(PEX_APPS.cvaVault)
      .limit(500)
      .do();

    type Dep = { round: number; paidUsd: number; shares: number };
    const deps: Dep[] = [];
    for (const tx of res.transactions ?? []) {
      const t = tx as unknown as Record<string, unknown>;
      const call = (t.applicationTransaction ?? t["application-transaction"]) as
        Record<string, unknown> | undefined;
      // The SDK returns camelCase `applicationArgs` with Uint8Array values;
      // older shapes and raw REST use other spellings. Accept all three — a
      // missed spelling reads as "this user has no deposits", which is silent
      // and wrong rather than loud and wrong.
      const rawArgs = (call?.applicationArgs ?? call?.appArgs
        ?? call?.["application-args"]) as (string | Uint8Array)[] | undefined;
      if (!rawArgs || rawArgs.length === 0) continue;
      const first = rawArgs[0];
      const sel = Buffer.from(
        typeof first === "string" ? Buffer.from(first, "base64") : first,
      ).toString("hex");
      if (sel !== CVA_SELECTORS.deposit) continue;

      const logs = (t.logs as (string | Uint8Array)[] | undefined) ?? [];
      if (logs.length === 0) continue;
      const f = fieldsOf(logs[0]);
      if (f.length <= DEPOSIT_SHARES_FIELD) continue;
      deps.push({
        round: Number(t.confirmedRound ?? t["confirmed-round"] ?? 0),
        paidUsd: f[DEPOSIT_VALUE_FIELD] / 1e6,
        shares: f[DEPOSIT_SHARES_FIELD] / 1e6,
      });
    }
    if (deps.length === 0) return null;

    // Newest first: the shares held now are the most recent deposits that
    // survived, so a suffix of the history is what we are looking for.
    deps.sort((a, b) => b.round - a.round);

    let paidUsd = 0, shares = 0, used = 0;
    for (const d of deps) {
      paidUsd += d.paidUsd;
      shares += d.shares;
      used += 1;
      // A micro-share of slack for rounding only.
      if (Math.abs(shares - sharesHeld) <= 1e-6) {
        return { paidUsd, shares, deposits: used };
      }
      if (shares > sharesHeld) break;   // overshot — no suffix reconciles
    }
    return null;
  } catch {
    // A basis we could not read is simply absent. It must never block the
    // position value, which is a chain read and always available.
    return null;
  }
}
