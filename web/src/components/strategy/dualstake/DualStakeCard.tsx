"use client";

/**
 * magnetALGO dualSTAKE — stake ALGO with Myth Finance, earn $U.
 *
 * Shaped after the C-Vault card deliberately: same `CardShell`, same drifting
 * blob, same `glow-text-card` heading, same amber `Learn more` beside the
 * title, same rate box, same `Stat` grid. A second strategy that invents its
 * own layout makes the page read as two products bolted together rather than
 * one shelf.
 *
 * ── What moved off this card, and why ─────────────────────────────────────
 * It used to carry a mechanism panel, a paragraph explaining why no rate was
 * shown, and a four-sentence amber disclosure, all on its face. That made it
 * by far the tallest card in the grid — enough that `items-start` had to be
 * added to the grid so the C-Vault beside it did not stretch — and it pushed
 * the figures a depositor came for below the fold on a phone.
 *
 * All of it is now in `DualStakeAbout`, none of it deleted. The C-Vault did
 * exactly this with its own disclosures: the card is the figures and the
 * action, Learn more is the argument.
 *
 * ── The rules this card follows ───────────────────────────────────────────
 *
 * 1. NEVER quote the ratio alone. magnetALGO redeems 1:1 for ALGO — measured
 *    exactly 1.00000000 across every mint and redeem on chain — and that
 *    number on its own is misleading, because the holding is worth *1 ALGO
 *    plus the $U accrued against it*. The accrual is the entire return. Copy
 *    here always says both.
 *
 * 2. The APR is DERIVED and says so. Myth's SDK does not publish one — their
 *    README, of both contract views: "Neither includes APR or farm info" —
 *    and their docs publish no figure either. So the headline is an expected
 *    consensus rate computed from live network parameters, labelled as an
 *    expectation, with the whole derivation in Learn more. See `yield.ts` for
 *    why it is the expected rate rather than a trailing realised one: three
 *    harvests is not a series, and annualising them carries a ±58% error.
 *
 *    This replaces the earlier "no rate at all" position, which was correct
 *    for as long as the only candidate was an extrapolation from our own
 *    history. It is not a reversal of the reasoning — the reasoning is what
 *    rejects the trailing figure and chose this one.
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
import { Coins } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel, MAGNET_GLOW } from "@/components/magnetfi/v2/shared";
import { ALGOD_URLS } from "@/lib/constants";
import algosdk from "algosdk";
import {
  accruedReward, readHolding, readSnapshot, toAlgo, toMagnetAlgo, toReward,
  type DualStakeSnapshot,
} from "@/lib/strategy/dualstake/reads";
import {
  netAprPct, readConsensusYield, type ConsensusYield,
} from "@/lib/strategy/dualstake/yield";
import { DualStakeActions } from "./DualStakeActions";
import { DualStakeAbout } from "./DualStakeAbout";

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

/**
 * The rate, in the metric box the rest of the site uses for one.
 *
 * Same frame as `CvaRateBox` and `LpPoolsSection`'s headline — `glow-accent
 * rounded-xl border-white/10 bg-black/30`, label and basis on the left, the
 * figure right in `font-mono text-[33px] font-bold text-green-400`. Matching
 * it is the point: an APR should look the same wherever this site shows one.
 *
 * ── Three states, and none of them is a number we did not read ────────────
 *   - read, node earning          -> the figure
 *   - read, node OFFLINE          -> the figure struck through, and why
 *   - unread                      -> a dash
 *
 * The offline case matters more than it looks. `grossAprPct` is a property of
 * the NETWORK, so it is perfectly readable while this particular contract is
 * earning nothing at all — the one state in which a confident green 4.5%
 * would be flatly false. The card already warned about it in a panel below;
 * the warning has to reach the figure itself.
 */
function DualStakeRateBox({ snapshot, yieldRead, loading }: {
  snapshot: DualStakeSnapshot | null;
  yieldRead: ConsensusYield | null;
  loading: boolean;
}) {
  const net = yieldRead && snapshot
    ? netAprPct(yieldRead.grossAprPct, snapshot.platformFeeBps, snapshot.noderunnerFeeBps)
    : null;
  /* `snapshot.earning` is `isOnline && incentiveEligible`. A null snapshot is
     unknown, not offline — it must not produce the struck-through state. */
  const offline = snapshot !== null && !snapshot.earning;

  return (
    <div className="glow-accent mb-2 mt-4 rounded-xl border border-white/10 bg-black/30 py-4 pl-5 pr-7">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-[17px] font-semibold leading-snug text-gray-200">
            Staking rate, paid in $U
          </p>
          <p className="mt-0.5 text-xs leading-snug text-gray-500">
            {/* Short enough to keep the figure on the label's own row, which
                is where CvaRateBox puts it. The first wording ran to 58
                characters and `flex-wrap` dropped the number onto a line of
                its own — not broken, but visibly unlike the card beside it,
                which is the one thing a shared frame exists to prevent.
                Rasterised side by side before and after. The full basis is
                in Learn more, under the derivation. */}
            {net !== null
              ? "Expected · net of Myth's fee"
              : loading ? "Reading the network…" : "Network parameters unavailable"}
          </p>
        </div>
        <p className={`font-mono text-[33px] font-bold leading-none ${
          net === null ? "text-gray-600"
            : offline ? "text-gray-500 line-through decoration-amber-400/70 decoration-2"
            : "text-green-400"
        }`}>
          {net !== null ? `${fmt(net, 2)}%` : loading ? "…" : "—"}
        </p>
      </div>

      {/* Why the figure is struck through, inside the same box as the figure.
          A caveat one element away gets read as being about something else. */}
      {offline && (
        <p className="mt-2.5 border-t border-white/[0.07] pt-2.5 text-[11px] leading-relaxed text-amber-200/90">
          Myth&apos;s node is not online and incentive-eligible right now, so nothing is accruing
          at this rate — or any other. Redeeming is unaffected.
        </p>
      )}
    </div>
  );
}

export function DualStakeCard() {
  const { address, isConnected, algodClient } = useWallet();
  const [snap, setSnap] = useState<DualStakeSnapshot | null>(null);
  /** `null` is unknown — never rendered as zero. */
  const [holding, setHolding] = useState<bigint | null>(null);
  const [yieldRead, setYieldRead] = useState<ConsensusYield | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    /*
      In parallel, and each independently fallible. Either coming back null
      degrades its own figure to a dash and leaves the rest of the card
      working — the same rule `fetchTVL` follows on /strategy.

      The harvest log is NOT read here. It pages the indexer to exhaustion,
      so its cost grows with the product, and nothing on the card's face
      shows it — `DualStakeAbout` fetches it when the modal first opens.
    */
    const [s, y] = await Promise.all([
      readSnapshot(ALGOD),
      readConsensusYield(ALGOD),
    ]);
    setSnap(s);
    setYieldRead(y);
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
        {/* Title and the Learn more pill on one row, exactly as the C-Vault
            has it — a lone pill under the heading read as an orphan there and
            would read the same here. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Coins className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />
              <h2 className="glow-text-card font-display text-[25px] font-bold tracking-tight text-white">
                magnetALGO
              </h2>
            </div>
            {/* One sentence, and it still says BOTH halves of the return —
                rule 1. The mechanism it used to be followed by is in Learn
                more. */}
            <p className="mt-1 text-sm text-gray-400">
              Liquid staking on Myth Finance. Your ALGO comes back 1:1, and the return is the{" "}
              <strong className="font-semibold text-gray-300">$U</strong> that accrues on top
              of it.
            </p>
          </div>
          <div className="shrink-0">
            <DualStakeAbout snapshot={snap} yieldRead={yieldRead} />
          </div>
        </div>

        <DualStakeRateBox snapshot={snap} yieldRead={yieldRead} loading={loading} />

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

        <DualStakeActions snapshot={snap} holding={holding} onDone={load} />

        {/*
          The disclosure, reduced to its one load-bearing sentence with the
          rest a click away.

          It is NOT removed and it is not softened: "not ours" is the thing a
          depositor has to know before they press the button, so it stays on
          the face where the button is. The upgrade path, the fee and the
          ceiling were three more sentences in the same amber box, which is
          how the box came to be longer than the card's own content — they are
          in Learn more under "What you carry", in full.
        */}
        <p className="text-[11px] leading-relaxed text-amber-200/70">
          <strong className="font-semibold text-amber-200/90">This is Myth Finance&apos;s
          contract, not ours.</strong>{" "}
          Depositing means trusting their code and their admin keys, and they can change both
          behind a one-week timelock. <span className="text-amber-200/55">Learn more has the
          detail.</span>
        </p>
      </div>
    </CardShell>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return <Panel glowClass={MAGNET_GLOW} className="relative p-5">{children}</Panel>;
}
