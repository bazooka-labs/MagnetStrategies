"use client";

/**
 * Deposit and redeem for magnetALGO.
 *
 * Every refusal here happens BEFORE a wallet prompt. A user who cannot
 * complete an action should learn it from a sentence, not from a rejected
 * signature or a raw `logic eval error` — the lesson the perps close path
 * taught twice.
 *
 * The deposit side states the $U cost up front. Minting is "X ALGO + Y $U",
 * and an earlier version of this form said only "Deposit ALGO": a user with no
 * $U met the requirement as a simulate failure, having already typed an amount
 * and clicked. The cost is small (about 0.0312 $U per 100 ALGO at the time of
 * writing) and it comes back on redemption, but it is not zero and it is not
 * optional.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import algosdk from "algosdk";
import { useWallet } from "@/hooks/useWallet";
import { ALGOD_URLS } from "@/lib/constants";
import { deposit, isDualStakeUnconfirmed, redeem } from "@/lib/strategy/dualstake/client";
import {
  MAGNET_ALGO_DECIMALS, MIN_DEPOSIT_MICRO_ALGO, REWARD_DECIMALS,
} from "@/lib/strategy/dualstake/config";
import {
  accruedReward, mintRewardCost, readRewardHolding, toAlgo, toMagnetAlgo, toReward,
  type DualStakeSnapshot, type RewardHolding,
} from "@/lib/strategy/dualstake/reads";
import { formatBaseUnits, parseBaseUnits } from "@/lib/strategy/dualstake/amount";

const ALGOD = ALGOD_URLS.mainnet;
type Mode = "deposit" | "redeem";

/** ALGO and magnetALGO share six decimals, which is what both inputs take. */
const INPUT_DECIMALS = MAGNET_ALGO_DECIMALS;

const fmtReward = (base: bigint) =>
  `${toReward(base).toLocaleString("en-US", { maximumFractionDigits: 5 })} $U`;

export function DualStakeActions({ snapshot, holding, onDone }: {
  snapshot: DualStakeSnapshot | null;
  /** magnetALGO base units; `null` means unknown, not zero. */
  holding: bigint | null;
  onDone: () => void;
}) {
  const { address, isConnected, signTransactions, algodClient } = useWallet();
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  /** The user's $U, for the deposit precheck. `null` means unknown. */
  const [reward, setReward] = useState<RewardHolding | null>(null);

  // Parsed from the DIGITS, never through a float — see `amount.ts`.
  const parsed = parseBaseUnits(amount, INPUT_DECIMALS);
  const base = parsed.ok ? parsed.base : null;
  const valid = base !== null && base > BigInt(0);

  const loadReward = useCallback(async () => {
    if (!address) { setReward(null); return; }
    const algod = algodClient ?? new algosdk.Algodv2("", ALGOD, "");
    setReward(await readRewardHolding(algod, address));
  }, [address, algodClient]);

  useEffect(() => { void loadReward(); }, [loadReward]);

  /** The $U a deposit of this size costs. Null when we cannot say. */
  const rewardCost = mode === "deposit" && valid && snapshot
    ? mintRewardCost(base, snapshot.rate) : null;

  /** Preview of what a deposit buys, or what a redemption returns. */
  const preview = (() => {
    if (!valid || !snapshot || base === null) return null;
    if (mode === "deposit") {
      const lst = toMagnetAlgo(base).toLocaleString("en-US", { maximumFractionDigits: 6 });
      // Both legs, always. The magnetALGO alone is not the whole transaction.
      return rewardCost !== null && rewardCost > BigInt(0)
        ? `≈ ${lst} magnetALGO, and costs ${fmtReward(rewardCost)}`
        : `≈ ${lst} magnetALGO`;
    }
    const u = accruedReward(base, snapshot.rate);
    return `≈ ${toAlgo(base).toLocaleString("en-US", { maximumFractionDigits: 6 })} ALGO`
      + ` + ${fmtReward(u)}`;
  })();

  async function run() {
    if (!address || !valid || base === null) return;
    const algod = algodClient ?? new algosdk.Algodv2("", ALGOD, "");
    setBusy(true);
    try {
      if (mode === "deposit") {
        await deposit({
          algod, algodServer: ALGOD, sign: signTransactions, sender: address,
          algoMicro: base,
        });
        toast.success("Deposited — magnetALGO is in your wallet");
      } else {
        await redeem({
          algod, algodServer: ALGOD, sign: signTransactions, sender: address,
          lstBase: base,
        });
        toast.success("Redeemed — ALGO and accrued $U are back in your wallet");
      }
      setAmount("");
      onDone();
      void loadReward();
    } catch (err) {
      // Submitted-but-unconfirmed is not a failure, and must not invite a
      // retry of something that may already have landed.
      if (isDualStakeUnconfirmed(err)) {
        toast(err.message);
        onDone();
      } else {
        toast.error(err instanceof Error ? err.message : "That didn't go through.");
      }
    } finally {
      setBusy(false);
    }
  }

  const capLeftMicro = snapshot ? snapshot.headroomMicroAlgo : null;

  /*
    Everything that makes the action impossible, resolved to one reason.

    Checked against base units rather than the rendered float, so a warning
    cannot disagree with the transaction. The over-balance cases also DISABLE
    the button: before this, redeeming more than you hold showed a warning and
    still let you click, landing on a raw simulate error.
  */
  const blocker: string | null = (() => {
    if (!parsed.ok && amount.trim() !== "") {
      if (parsed.error === "too_precise") {
        return `More than ${INPUT_DECIMALS} decimal places — that is the smallest unit.`;
      }
      if (parsed.error === "negative") return "Enter a positive amount.";
      if (parsed.error === "not_a_number") return "Enter an amount in digits.";
      return null;
    }
    if (base === null || !valid) return null;

    if (mode === "deposit") {
      if (base < BigInt(MIN_DEPOSIT_MICRO_ALGO)) {
        return `Minimum ${MIN_DEPOSIT_MICRO_ALGO / 1e6} ALGO — below that the network `
          + "fees take most of it.";
      }
      if (capLeftMicro !== null && base > capLeftMicro) {
        return "More than the protocol's remaining capacity "
          + `(${toAlgo(capLeftMicro).toLocaleString()} ALGO).`;
      }
      if (snapshot?.upgrading) {
        return "A contract upgrade is queued at Myth, so deposits are paused here until "
          + "we have read it. Redeeming is unaffected.";
      }
      if (rewardCost !== null && rewardCost > BigInt(0) && reward !== null) {
        if (!reward.optedIn) {
          return `This also costs ${fmtReward(rewardCost)}, and this wallet isn't opted `
            + "into $U yet. The Trade page can swap some for you.";
        }
        if (reward.balance < rewardCost) {
          return `This also costs ${fmtReward(rewardCost)}, and you hold `
            + `${fmtReward(reward.balance)}. It comes back when you redeem.`;
        }
      }
      return null;
    }

    if (holding !== null && base > holding) {
      return `You hold ${formatBaseUnits(holding, INPUT_DECIMALS)} magnetALGO.`;
    }
    return null;
  })();

  const canSubmit = isConnected && valid && !busy && blocker === null;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div role="tablist" aria-label="Deposit or redeem"
        className="mb-3 inline-flex rounded-full border border-white/10 bg-black/40 p-0.5">
        {(["deposit", "redeem"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m}
            onClick={() => { setMode(m); setAmount(""); }}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              mode === m ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white"
                : "text-white/50 hover:text-white"}`}>
            {m === "deposit" ? "Deposit ALGO" : "Redeem"}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-lg border border-gray-700 bg-black/30 px-3 focus-within:border-magnet-500">
          <input
            type="number" min={0} step="any" value={amount} placeholder="0.00"
            aria-label={mode === "deposit" ? "ALGO to deposit" : "magnetALGO to redeem"}
            aria-invalid={blocker !== null}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none" />
          <span className="shrink-0 text-xs font-medium text-gray-500">
            {mode === "deposit" ? "ALGO" : "magnetALGO"}
          </span>
        </div>
        {/* Exact: the whole holding, straight from base units. A float round
            trip here stranded a base unit in about 2% of holdings. */}
        {mode === "redeem" && holding !== null && holding > BigInt(0) && (
          <button onClick={() => setAmount(formatBaseUnits(holding, INPUT_DECIMALS))}
            className="shrink-0 text-xs text-magnet-400 hover:text-magnet-300">Max</button>
        )}
      </div>

      <div aria-live="polite">
        {preview && <p className="mt-2 text-xs text-gray-500">{preview}</p>}
        {blocker && <p className="mt-2 text-xs text-amber-300">{blocker}</p>}
      </div>

      <button
        onClick={() => void run()}
        disabled={!canSubmit}
        className="mt-3 w-full rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-2.5 text-sm font-semibold text-white transition-all hover:from-magnet-500 hover:to-magnet-400 disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Confirming…"
          : !isConnected ? "Connect a wallet"
          : mode === "deposit" ? "Deposit ALGO + $U" : "Redeem magnetALGO"}
      </button>
    </div>
  );
}
