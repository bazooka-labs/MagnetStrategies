"use client";

/**
 * magnetALGO dualSTAKE — stake ALGO with Myth Finance, earn $U.
 *
 * Shaped after the C-Vault card deliberately: same `CardShell`, same drifting
 * blob, same `glow-text-card` heading, same `Stat` grid. A second strategy
 * that invents its own layout makes the page read as two products bolted
 * together rather than one shelf.
 *
 * ── Two rules this card follows that the others do not have to ────────────
 *
 * 1. NEVER quote the ratio alone. magnetALGO redeems 1:1 for ALGO — measured
 *    exactly 1.00000000 across every mint and redeem on chain — and that
 *    number on its own is misleading, because the holding is worth *1 ALGO
 *    plus the $U accrued against it*. The accrual is the entire return. Copy
 *    here always says both.
 *
 * 2. NO APR. The yield is consensus rewards swapped into $U through a ~$9.5K
 *    Tinyman pool, so realised return depends on harvest slippage, which
 *    grows with TVL. One observed redemption is not an annualised rate, and
 *    inventing one would be the same error as a payout figure derived from a
 *    price we could not read. The card shows the mechanism and the accrued
 *    amount, and withholds the rate until there is a measured series.
 */

import { useCallback, useEffect, useState } from "react";
import { Coins, ExternalLink, Info } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel, MAGNET_GLOW } from "@/components/magnetfi/v2/shared";
import { ALGOD_URLS } from "@/lib/constants";
import algosdk from "algosdk";
import {
  accruedReward, readHolding, readSnapshot, toAlgo, toMagnetAlgo, toReward,
  type DualStakeSnapshot,
} from "@/lib/strategy/dualstake/reads";
import { DualStakeActions } from "./DualStakeActions";

const ALGOD = ALGOD_URLS.mainnet;

function Stat({ label, value, tone }: {
  label: string; value: string; tone?: "up" | "muted";
}) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`mt-0.5 font-mono text-base ${
        tone === "up" ? "text-green-400" : tone === "muted" ? "text-gray-400" : "text-gray-200"
      }`}>{value}</dd>
    </div>
  );
}

const fmt = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function DualStakeCard() {
  const { address, isConnected, algodClient } = useWallet();
  const [snap, setSnap] = useState<DualStakeSnapshot | null>(null);
  /** `null` is unknown — never rendered as zero. */
  const [holding, setHolding] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const s = await readSnapshot(ALGOD);
    setSnap(s);
    if (address) {
      const algod = algodClient ?? new algosdk.Algodv2("", ALGOD, "");
      setHolding(await readHolding(algod, address));
    } else {
      setHolding(null);
    }
    setLoading(false);
  }, [address, algodClient]);

  useEffect(() => { void load(); }, [load]);

  const accrued = snap && holding !== null ? accruedReward(holding, snap.rate) : null;

  return (
    <CardShell>
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="animate-blob-drift absolute -right-20 -top-20 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
      </div>

      <div className="relative flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Coins className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />
              <h2 className="glow-text-card font-display text-[25px] font-bold tracking-tight text-white">
                magnetALGO
              </h2>
            </div>
            <p className="mt-1 text-sm text-gray-400">
              Stake ALGO with Myth Finance and earn <strong className="font-semibold text-gray-300">$U</strong>.
              Your ALGO comes back 1:1 — the return is the $U that accrues on top.
            </p>
          </div>
        </div>

        {/* The mechanism, stated before any figure. It is the reason the
            rewards are in $U at all, and the thing that makes this card
            different from an ordinary liquid-staking box. */}
        <div className="rounded-xl border border-magnet-400/20 bg-magnet-500/[0.06] px-4 py-3">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-gray-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magnet-300" aria-hidden="true" />
            <span>
              The contract stakes your ALGO in Algorand consensus and swaps the rewards into
              $U. Redeem any time for <strong className="font-semibold text-gray-300">1 ALGO
              per magnetALGO plus the $U accrued</strong> — there is no unbonding period and
              no dependence on pool liquidity to exit.
            </span>
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Total staked"
            value={snap ? `${fmt(toAlgo(snap.stakedMicroAlgo), 0)} ALGO` : loading ? "…" : "—"} />
          <Stat label="Capacity left"
            value={snap ? `${fmt(toAlgo(snap.headroomMicroAlgo), 0)} ALGO` : loading ? "…" : "—"}
            tone="muted" />
          <Stat label="Your magnetALGO"
            value={!isConnected ? "—"
              : holding === null ? (loading ? "…" : "—")
              : `${fmt(toMagnetAlgo(holding), 4)}`} />
          <Stat label="$U accrued to you"
            value={!isConnected ? "—"
              : accrued === null ? (loading ? "…" : "—")
              : `${fmt(toReward(accrued), 5)} $U`}
            tone={accrued !== null && accrued > BigInt(0) ? "up" : undefined} />
        </dl>

        {/* Deliberately no APR — see the file header. Saying why beats an
            empty space a reader fills with their own guess. */}
        <p className="text-[11px] leading-relaxed text-white/35">
          No rate is shown yet. The yield is consensus rewards converted to $U, so the realised
          return depends on conversion slippage and on how long the position is held — we will
          publish a rate once there is enough history to measure one rather than estimate it.
        </p>

        <DualStakeActions snapshot={snap} holding={holding} onDone={load} />

        {/* The disclosure. A third-party contract is not our audited code and
            the card says which it is, in those words. */}
        <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-4 py-3">
          <p className="text-[11px] leading-relaxed text-amber-200/80">
            <strong className="font-semibold">This is Myth Finance&apos;s contract, not ours.</strong>{" "}
            Depositing means trusting their code and their admin keys. It is upgradeable behind a
            one-week timelock with the new code&apos;s hash published in advance, and holders who
            disagree can redeem immediately or protest. Fees are {snap
              ? `${(snap.platformFeeBps + snap.noderunnerFeeBps) / 100}%`
              : "6.5%"} of rewards
            ({snap ? snap.platformFeeBps / 100 : 2.5}% platform,{" "}
            {snap ? snap.noderunnerFeeBps / 100 : 4}% node runner).{" "}
            <a href="https://docs.myth.finance/dualSTAKE/overview" target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-amber-100">
              Myth&apos;s docs <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      </div>
    </CardShell>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return <Panel glowClass={MAGNET_GLOW} className="relative p-5">{children}</Panel>;
}
