"use client";

/**
 * magnetALGO dualSTAKE — stake ALGO with Myth Finance, earn $U.
 *
 * Shaped after the C-Vault card deliberately: same `CardShell`, same drifting
 * blob, same `glow-text-card` heading, same `Stat` grid. A second strategy
 * that invents its own layout makes the page read as two products bolted
 * together rather than one shelf.
 *
 * ── Three rules this card follows that the others do not have to ───────────
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
 *
 * 3. The $U figure is labelled GROSS, because that is what it is. `rate *
 *    holding` is the $U a redemption pays out, and part of it is the $U the
 *    user themselves put in at mint — minting is "X ALGO + Y $U". An earlier
 *    version labelled it "$U accrued to you" and tinted it green, which
 *    showed a user who had just deposited their own entry cost as profit.
 *    Net accrual needs the rate at THEIR mint, which the chain does not give
 *    us per holder, so the card shows the gross figure under an honest label
 *    rather than a net one it cannot compute.
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
import { FEE_UPDATE_MAX_DELTA_BPS } from "@/lib/strategy/dualstake/config";
import { DualStakeActions } from "./DualStakeActions";

const ALGOD = ALGOD_URLS.mainnet;

function Stat({ label, value, tone }: {
  label: string; value: string; tone?: "up" | "muted";
}) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      {/* `min-w-0` and wrapping: at 360px each grid column is about 135px and
          "64,950,681 ALGO" in `text-base` mono is wider than that. */}
      <dd className={`mt-0.5 min-w-0 break-words font-mono text-base ${
        tone === "up" ? "text-green-400" : tone === "muted" ? "text-gray-400" : "text-gray-200"
      }`}>{value}</dd>
    </div>
  );
}

const fmt = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/**
 * Like `fmt`, but never renders a non-zero amount as zero.
 *
 * At 4dp a holding of 0.00004 magnetALGO printed "0.0000", which reads as "you
 * have none" when the figure beside it is about to pay out. A real zero still
 * shows as zero; anything smaller than the last displayed digit gets "< ".
 */
const small = (n: number, dp: number) => {
  const floor = 10 ** -dp;
  return n > 0 && n < floor ? `< ${floor.toFixed(dp)}` : fmt(n, dp);
};

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
              Your ALGO comes back 1:1, and the return is the $U that accrues on top of it.
            </p>
          </div>
        </div>

        {/* The mechanism, stated before any figure. It is the reason the
            rewards are in $U at all, and the thing that makes this card
            different from an ordinary liquid-staking box.

            ── On "without depending on pool liquidity" ───────────────────────
            Both audits flagged this clause as unsubstantiated, and I removed
            it. That was the right call on the evidence I had and the wrong
            conclusion: the claim is true, and structurally so.

            Redemption is fixed per token — locked ALGO plus $U, straight from
            the contract. No pool is involved. The proof is in the rate's own
            definition, `asaBalance / staked`: the $U owed is DERIVED from the
            $U already held, so if every token outstanding redeemed at once the
            contract would owe 1,538,506 base $U against 1,538,507 on hand
            (measured 2026-11-07; the one unit is floor rounding, in its
            favour). A payout computed from the balance can never exceed it, so
            it can never need a swap to cover it.

            What misled me: Myth's docs say the reward swap runs before a mint
            or a redeem, and the SDK passes Tinyman as a reference on both
            paths. Both are true and neither bears on the payout — the swap
            tops up accrual, it does not fund the exit. `dualstake.live.test`
            pins the backing invariant, so if Myth ever redefines the rate this
            sentence fails a test rather than quietly becoming false. */}
        <div className="rounded-xl border border-magnet-400/20 bg-magnet-500/[0.06] px-4 py-3">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-gray-400">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-magnet-300" aria-hidden="true" />
            <span>
              The contract stakes your ALGO in Algorand consensus and swaps the rewards into
              $U. Redeem any time for <strong className="font-semibold text-gray-300">1 ALGO
              per magnetALGO plus the $U accrued</strong> — a fixed amount, paid straight from
              the contract, with no unbonding period and no pool to exit through. Minting also
              costs a little $U up front, because a new token has to arrive backed like the
              existing ones; that comes back when you redeem.
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
              : small(toMagnetAlgo(holding), 4)} />
          {/* Labelled "on redemption", not "accrued" — rule 3 in the header.
              Not tinted green either: a gross figure is not a gain. */}
          <Stat label="$U on redemption"
            value={!isConnected ? "—"
              : accrued === null ? (loading ? "…" : "—")
              : `${small(toReward(accrued), 5)} $U`} />
        </dl>

        {/*
          Whether the node is actually earning.

          `snapshot.earning` was read from the start and never displayed, while
          the copy above asserts the contract "stakes your ALGO in Algorand
          consensus". That claim has a live truth value — online, and incentive
          eligible — and if it ever goes false the yield stops while the card
          goes on describing it. Only shown when false, because "working
          normally" does not need a badge.
        */}
        {snap && !snap.earning && (
          <p className="rounded-lg border border-amber-400/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            Myth&apos;s node is not currently online and incentive-eligible, so no consensus
            rewards are accruing right now. Redeeming is unaffected.
          </p>
        )}

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
            disagree can redeem immediately or protest.{" "}
            {/* Read live or not stated. It used to fall back to a hardcoded
                "6.5% (2.5% platform, 4% node runner)" whenever `snap` was
                null, which rendered a figure we had failed to read as though
                we had read it — the one thing every other stat on this card
                refuses to do. Fees are also not fixed: `fee_update_max_delta`
                is 250bps per `fee_update_period` of one week. */}
            {snap ? <>
              Fees are {(snap.platformFeeBps + snap.noderunnerFeeBps) / 100}% of rewards
              ({snap.platformFeeBps / 100}% platform, {snap.noderunnerFeeBps / 100}% node
              runner), and Myth may raise them by up to{" "}
              {FEE_UPDATE_MAX_DELTA_BPS / 100}% a week.
            </> : <>
              We couldn&apos;t read the current fees; Myth takes a share of rewards and may
              raise it by up to {FEE_UPDATE_MAX_DELTA_BPS / 100}% a week.
            </>}{" "}
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
