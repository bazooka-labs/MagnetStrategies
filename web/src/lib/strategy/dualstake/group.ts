// ── magnetALGO dualSTAKE — pre-sign group assertion ───────────────────────
//
// The transactions are built by Myth's SDK. This checks them before the user
// is asked to sign.
//
// ── Why assert a group an official SDK built ──────────────────────────────
// Because "official" is a statement about provenance, not about the bytes in
// front of us. The SDK is a dependency: it updates, it has a supply chain,
// and it is not ours. Nothing in this app signs a group it has not checked
// itself, and a third-party builder is the case that rule exists for.
//
// Every allowed value here is an enumeration WE build from pinned constants —
// never "whatever the group happens to name". That is the same rule
// `pex/group.ts` documents, and the same one that let an ALGO close through
// safely once `pinnedPoolAssets` was written correctly.

import type algosdk from "algosdk";
import {
  ARC59_APP_ID, DUALSTAKE_APP_ADDRESS, DUALSTAKE_APP_ID, MAGNET_ALGO_ASA_ID,
  MAX_MINT_GROUP_FEE_MICRO_ALGO, MAX_REDEEM_GROUP_FEE_MICRO_ALGO,
  MINT_SELECTOR, REDEEM_SELECTOR, REWARD_ASA_ID, TINYMAN_APP_ID,
} from "./config";

/**
 * Transaction types this flow may contain.
 *
 * A whitelist, not a blacklist, because the cost of the two being different is
 * asymmetric: an unlisted type that should be allowed produces a refusal the
 * live test catches, whereas an unchecked type that should be refused produces
 * a signature. Before this existed, `keyreg` and `acfg` matched none of the
 * branches below and passed unexamined — so a group could have carried a
 * `nonParticipation` key registration, permanently and irreversibly ending the
 * user's own consensus participation, and the assertion would have returned ok.
 */
const ALLOWED_TXN_TYPES = new Set(["pay", "axfer", "appl"]);

/** `OnApplicationComplete.NoOpOC`. Anything else touches local state. */
const ON_COMPLETE_NOOP = 0;

const hex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

export interface AssertResult {
  ok: boolean;
  failures: { code: string; detail: string }[];
  checked: string[];
}

/** Apps this flow may call. Anything else is a refusal, not a warning. */
const ALLOWED_APPS = new Set([DUALSTAKE_APP_ID, TINYMAN_APP_ID, ARC59_APP_ID]);
/** Assets this flow may move. ALGO is not an ASA and never appears here. */
const ALLOWED_ASSETS = new Set([MAGNET_ALGO_ASA_ID, REWARD_ASA_ID]);

/**
 * Check a built mint or redeem group.
 *
 * `expectedAlgoMicro` is what the user typed, and is checked to the microALGO
 * — the SDK deriving the $U leg is fine, but the ALGO leg is the number on
 * screen and must match it exactly.
 */
export function assertDualStakeGroup(
  txns: algosdk.Transaction[],
  opts: {
    sender: string;
    kind: "mint" | "redeem";
    /** Mint only: the exact ALGO the user asked to deposit. */
    expectedAlgoMicro?: bigint;
    /** Redeem only: the exact magnetALGO the user asked to redeem. */
    expectedLstBase?: bigint;
    /**
     * An independently computed upper bound for the $U leg of a mint.
     *
     * We do NOT re-derive the amount — the SDK owns that, and re-deriving it
     * was exactly the mistake an earlier reverse-engineered draft made. We do
     * bound it, from our own `getRate()` read, because an unbounded transfer
     * of a second asset is the one thing a user could not see coming.
     */
    maxRewardBase?: bigint;
  },
): AssertResult {
  const failures: { code: string; detail: string }[] = [];
  const checked: string[] = [];
  const fail = (code: string, detail: string) => failures.push({ code, detail });
  const did = (what: string) => checked.push(what);

  if (txns.length === 0 || txns.length > 8) {
    fail("shape", `group has ${txns.length} transactions; expected 1-8`);
  }
  did("group size within envelope");

  let totalFee = BigInt(0);
  let algoToApp = BigInt(0);
  let rewardToApp = BigInt(0);
  let lstToApp = BigInt(0);
  /** App calls to dualSTAKE itself, by selector. The group's actual purpose. */
  const dualstakeCalls: string[] = [];

  for (const [i, t] of txns.entries()) {
    totalFee += BigInt(t.fee ?? 0);

    // The type whitelist comes FIRST: every check below is written against a
    // specific transaction shape, so an unrecognised type must be refused
    // rather than fall past all of them.
    if (!ALLOWED_TXN_TYPES.has(String(t.type))) {
      fail("txn_type", `txn ${i} is a ${String(t.type)}, which this flow never uses`);
    }

    // Nobody but the user may be paying, and nothing may re-key or close out.
    if (t.sender.toString() !== opts.sender) {
      fail("sender", `txn ${i} is sent by ${t.sender.toString()}, not the user`);
    }
    if (t.rekeyTo) fail("rekey", `txn ${i} sets rekeyTo`);

    if (t.payment) {
      const to = t.payment.receiver.toString();
      if (t.payment.closeRemainderTo) fail("close_out", `txn ${i} sets closeRemainderTo`);
      // Every outbound destination must be one we pinned. This is the rule
      // that stops a swapped-in dependency redirecting funds.
      if (to !== DUALSTAKE_APP_ADDRESS) {
        fail("value_leaves", `txn ${i} pays ALGO to ${to}, which is not the dualSTAKE app`);
      } else {
        algoToApp += BigInt(t.payment.amount);
      }
    }

    if (t.assetTransfer) {
      const a = t.assetTransfer;
      const assetId = Number(a.assetIndex);
      if (!ALLOWED_ASSETS.has(assetId)) {
        fail("asset_unpinned", `txn ${i} moves asset ${assetId}, which this flow never uses`);
      }
      if (a.assetSender) fail("clawback", `txn ${i} is a clawback transfer`);
      if (a.closeRemainderTo) fail("close_out", `txn ${i} closes out an asset holding`);
      const to = a.receiver.toString();
      const isOptIn = BigInt(a.amount) === BigInt(0) && to === opts.sender;
      if (!isOptIn && to !== DUALSTAKE_APP_ADDRESS) {
        fail("value_leaves", `txn ${i} sends asset ${assetId} to ${to}, which is not the dualSTAKE app`);
      }
      if (to === DUALSTAKE_APP_ADDRESS) {
        if (assetId === REWARD_ASA_ID) rewardToApp += BigInt(a.amount);
        if (assetId === MAGNET_ALGO_ASA_ID) lstToApp += BigInt(a.amount);
      }
    }

    if (t.applicationCall) {
      const ac = t.applicationCall;
      const appId = Number(ac.appIndex);
      if (!ALLOWED_APPS.has(appId)) {
        fail("app_unpinned", `txn ${i} calls app ${appId}, which this flow never uses`);
      }
      // A NoOp call cannot alter the user's local state. An OptIn, CloseOut,
      // ClearState, Update or Delete can — a CloseOut of Tinyman would have
      // destroyed the user's position there, inside a group they believed was
      // a redemption.
      if (Number(ac.onComplete ?? 0) !== ON_COMPLETE_NOOP) {
        fail("on_complete", `txn ${i} calls app ${appId} with onComplete `
          + `${Number(ac.onComplete)}, not NoOp`);
      }
      if (appId === DUALSTAKE_APP_ID) {
        dualstakeCalls.push(ac.appArgs?.[0] ? hex(ac.appArgs[0]) : "(no selector)");
      }
    }
  }
  did("transaction types limited to pay, axfer and appl");
  did("every transaction sent by the user, no rekey, no close-out");
  did("every destination pinned to the dualSTAKE app");
  did("assets limited to magnetALGO and $U");
  did("apps limited to dualSTAKE, Tinyman and the ARC-59 router");
  did("every app call is a NoOp");

  /*
    The group must DO the thing, not merely move money in the right direction.

    Exactly one call to dualSTAKE, carrying the selector for the action the
    user asked for. Without this, destinations and amounts can all be correct
    while the group accomplishes nothing: a lone `pay -> app` passed every
    other check here and would have handed the contract the user's ALGO with
    no magnetALGO minted in return, and a lone `axfer` of magnetALGO would
    have stranded it in the app with no redemption.
  */
  const wantSelector = opts.kind === "mint" ? MINT_SELECTOR : REDEEM_SELECTOR;
  if (dualstakeCalls.length !== 1) {
    fail("app_call", `group has ${dualstakeCalls.length} calls to the dualSTAKE app; `
      + "expected exactly 1");
  } else if (dualstakeCalls[0] !== wantSelector) {
    fail("selector", `the dualSTAKE call carries selector ${dualstakeCalls[0]}, `
      + `not ${opts.kind}'s ${wantSelector}`);
  }
  did(`exactly one dualSTAKE ${opts.kind} call, by pinned selector`);

  const feeCap = opts.kind === "mint"
    ? MAX_MINT_GROUP_FEE_MICRO_ALGO : MAX_REDEEM_GROUP_FEE_MICRO_ALGO;
  if (totalFee > BigInt(feeCap)) {
    fail("fee_cap", `total fee ${totalFee} exceeds ${feeCap} microALGO`);
  }
  did("group fee within cap");

  if (opts.kind === "mint") {
    if (opts.expectedAlgoMicro === undefined) {
      fail("missing_bound", "a mint must be checked against the amount the user typed");
    } else if (algoToApp !== opts.expectedAlgoMicro) {
      fail("amount", `group deposits ${algoToApp} microALGO, the screen said ${opts.expectedAlgoMicro}`);
    }
    if (opts.maxRewardBase !== undefined && rewardToApp > opts.maxRewardBase) {
      fail("reward_leg", `group sends ${rewardToApp} base $U, above the bound ${opts.maxRewardBase}`);
    }
    if (lstToApp !== BigInt(0)) {
      fail("unexpected_leg", `a mint sent ${lstToApp} magnetALGO to the app`);
    }
    did("ALGO deposited equals the amount on screen");
    did("$U leg within an independently computed bound");
  } else {
    if (opts.expectedLstBase === undefined) {
      fail("missing_bound", "a redeem must be checked against the amount the user typed");
    } else if (lstToApp !== opts.expectedLstBase) {
      fail("amount", `group redeems ${lstToApp} magnetALGO, the screen said ${opts.expectedLstBase}`);
    }
    if (algoToApp !== BigInt(0)) {
      fail("unexpected_leg", `a redeem paid ${algoToApp} microALGO to the app`);
    }
    /*
      A redemption PAYS OUT $U. It never sends any.

      This was the sharpest hole the audit found: `rewardToApp` was computed
      for both paths but bounded only on a mint, so a redeem group could carry
      an asset transfer of the user's entire $U balance to the app address —
      a destination that passed `value_leaves` because it is the pinned app —
      and the assertion returned ok. The bound on a mint is a ceiling because
      the SDK owns that amount; here the only correct amount is zero.
    */
    if (rewardToApp !== BigInt(0)) {
      fail("unexpected_leg", `a redeem sent ${rewardToApp} base $U to the app; `
        + "a redemption pays $U out and never in");
    }
    did("magnetALGO redeemed equals the amount on screen");
    did("no ALGO and no $U leaves the user on a redeem");
  }

  return { ok: failures.length === 0, failures, checked };
}
