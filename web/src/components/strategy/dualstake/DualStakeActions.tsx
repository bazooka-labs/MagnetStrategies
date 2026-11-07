"use client";

/**
 * Deposit and redeem for magnetALGO.
 *
 * Every refusal here happens BEFORE a wallet prompt. A user who cannot
 * complete an action should learn it from a sentence, not from a rejected
 * signature or a raw `logic eval error` — the lesson the perps close path
 * taught twice.
 */

import { useState } from "react";
import { toast } from "sonner";
import algosdk from "algosdk";
import { useWallet } from "@/hooks/useWallet";
import { ALGOD_URLS } from "@/lib/constants";
import { deposit, isDualStakeUnconfirmed, redeem } from "@/lib/strategy/dualstake/client";
import { MIN_DEPOSIT_MICRO_ALGO } from "@/lib/strategy/dualstake/config";
import {
  accruedReward, toAlgo, toMagnetAlgo, toReward,
  type DualStakeSnapshot,
} from "@/lib/strategy/dualstake/reads";

const ALGOD = ALGOD_URLS.mainnet;
type Mode = "deposit" | "redeem";

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

  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0;

  /** Preview of what a deposit buys, or what a redemption returns. */
  const preview = (() => {
    if (!valid || !snapshot) return null;
    if (mode === "deposit") {
      const base = BigInt(Math.floor(n * 1e6));
      return `≈ ${toMagnetAlgo(base).toLocaleString("en-US", { maximumFractionDigits: 4 })} magnetALGO`;
    }
    const base = BigInt(Math.floor(n * 1e6));
    const u = accruedReward(base, snapshot.rate);
    return `≈ ${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} ALGO`
      + ` + ${toReward(u).toLocaleString("en-US", { maximumFractionDigits: 5 })} $U`;
  })();

  async function run() {
    if (!address || !valid) return;
    const algod = algodClient ?? new algosdk.Algodv2("", ALGOD, "");
    setBusy(true);
    try {
      if (mode === "deposit") {
        await deposit({
          algod, algodServer: ALGOD, sign: signTransactions, sender: address,
          algoMicro: BigInt(Math.floor(n * 1e6)),
        });
        toast.success("Deposited — magnetALGO is in your wallet");
      } else {
        await redeem({
          algod, algodServer: ALGOD, sign: signTransactions, sender: address,
          lstBase: BigInt(Math.floor(n * 1e6)),
        });
        toast.success("Redeemed — ALGO and accrued $U are back in your wallet");
      }
      setAmount("");
      onDone();
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

  const maxRedeem = holding !== null ? toMagnetAlgo(holding) : null;
  const capLeft = snapshot ? toAlgo(snapshot.headroomMicroAlgo) : null;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="mb-3 inline-flex rounded-full border border-white/10 bg-black/40 p-0.5">
        {(["deposit", "redeem"] as const).map((m) => (
          <button key={m} onClick={() => { setMode(m); setAmount(""); }}
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
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none" />
          <span className="shrink-0 text-xs font-medium text-gray-500">
            {mode === "deposit" ? "ALGO" : "magnetALGO"}
          </span>
        </div>
        {mode === "redeem" && maxRedeem !== null && maxRedeem > 0 && (
          <button onClick={() => setAmount(String(maxRedeem))}
            className="shrink-0 text-xs text-magnet-400 hover:text-magnet-300">Max</button>
        )}
      </div>

      {preview && <p className="mt-2 text-xs text-gray-500">{preview}</p>}

      {/* Stated up front rather than discovered at the prompt. */}
      {mode === "deposit" && valid && n * 1e6 < MIN_DEPOSIT_MICRO_ALGO && (
        <p className="mt-2 text-xs text-amber-300">
          Minimum {MIN_DEPOSIT_MICRO_ALGO / 1e6} ALGO — below that the network fees take most of it.
        </p>
      )}
      {mode === "deposit" && valid && capLeft !== null && n > capLeft && (
        <p className="mt-2 text-xs text-amber-300">
          More than the protocol&apos;s remaining capacity ({capLeft.toLocaleString()} ALGO).
        </p>
      )}
      {mode === "redeem" && valid && maxRedeem !== null && n > maxRedeem && (
        <p className="mt-2 text-xs text-amber-300">
          You hold {maxRedeem.toLocaleString("en-US", { maximumFractionDigits: 4 })} magnetALGO.
        </p>
      )}
      {snapshot?.upgrading && mode === "deposit" && (
        <p className="mt-2 text-xs text-amber-300">
          A contract upgrade is queued at Myth, so deposits are paused here until we have read
          it. Redeeming is unaffected.
        </p>
      )}

      <button
        onClick={() => void run()}
        disabled={!isConnected || !valid || busy}
        className="mt-3 w-full rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-2.5 text-sm font-semibold text-white transition-all hover:from-magnet-500 hover:to-magnet-400 disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Confirming…"
          : !isConnected ? "Connect a wallet"
          : mode === "deposit" ? "Deposit ALGO" : "Redeem magnetALGO"}
      </button>
    </div>
  );
}
