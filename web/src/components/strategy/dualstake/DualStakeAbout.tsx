"use client";

/**
 * "What am I actually depositing into?" — the magnetALGO explainer.
 *
 * Modelled on `CvaAbout` so the two strategies read as one site: amber
 * `RAISED_AMBER` trigger beside the heading, portal modal, magnet-tinted
 * frame with the hairline across the top, four section panels, then the
 * numbers, then "What you carry" last.
 *
 * ── Why this modal exists ─────────────────────────────────────────────────
 * The card carried all of this on its face: a mechanism panel, a paragraph
 * explaining why no rate was shown, and a four-sentence amber disclosure. It
 * was the tallest card in the grid by a wide margin and the figures a
 * depositor came for were below the fold on a phone. None of it was wrong, so
 * none of it is deleted — it moved behind one click, which is what the
 * C-Vault did with its own disclosures for the same reason.
 *
 * ── The rule this modal follows that CvaAbout also follows ────────────────
 * Every figure is labelled with where it comes from, and the derived one says
 * so. The card's headline is an EXPECTED rate from current network
 * parameters; the harvest log below is REALISED and is never annualised. Two
 * numbers of different kinds, each named as what it is — the C-Vault learned
 * that lesson when an annualized headline sat beside a realised ladder with
 * nothing saying which was which.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, BookOpen, Calculator, Coins, Scale, Shuffle, X,
} from "lucide-react";
import { RAISED_AMBER } from "@/components/raisedButton";
import {
  FEE_UPDATE_MAX_DELTA_BPS, MAGNET_ALGO_ASA_ID, MAX_BALANCE_MICRO_ALGO,
} from "@/lib/strategy/dualstake/config";
import { toAlgo, toReward, type DualStakeSnapshot } from "@/lib/strategy/dualstake/reads";
import {
  netAprPct, proposalsPerDay, type ConsensusYield,
} from "@/lib/strategy/dualstake/yield";
import {
  harvestTotals, realisedRewardPerAlgo, type Harvest,
} from "@/lib/strategy/dualstake/events";

const num = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const SECTIONS: { icon: React.ReactNode; title: string; body: React.ReactNode }[] = [
  {
    icon: <Coins className="h-5 w-5" />,
    title: "What dualSTAKE is",
    body: (
      <>
        A liquid staking product built by{" "}
        <strong className="font-semibold text-gray-300">Myth Finance</strong>, not by us. You
        deposit ALGO into their contract and receive{" "}
        <strong className="font-semibold text-gray-300">magnetALGO</strong>, a token that
        represents your deposit and stays in your own wallet. Myth run the Algorand consensus
        node the deposits stake through. Magnet Strategies writes none of those contracts and
        custodies none of the money — this card builds the calls and your own wallet signs them.
      </>
    ),
  },
  {
    icon: <Scale className="h-5 w-5" />,
    title: "How it earns",
    body: (
      <>
        {/* The mechanism, which used to be the Info panel on the card. It is
            the reason the rewards are in $U at all. */}
        Algorand pays a reward to whoever proposes each block, and an account&apos;s chance of
        proposing is its share of all the ALGO staked on the network. The contract is online
        and eligible, so it collects those rewards on the whole staked balance — and then{" "}
        <strong className="font-semibold text-gray-300">swaps them out of ALGO and into
        $U</strong>, which is what accrues to magnetALGO holders. That swap is why this is the
        one strategy on the site where staking ALGO creates standing demand for our own token.
      </>
    ),
  },
  {
    icon: <Shuffle className="h-5 w-5" />,
    title: "Minting costs $U too",
    body: (
      <>
        Depositing is <em>dual</em>: the group sends ALGO{" "}
        <strong className="font-semibold text-gray-300">and a little $U</strong>, because a new
        token has to arrive backed by the same $U per token as every token already outstanding.
        The amount is the current rate times your deposit — about 0.031 $U per 100 ALGO at the
        time of writing — and it is named in the preview before you sign. It is not a fee and
        nobody keeps it: it comes back to you on redemption, along with everything that accrued
        after it.
      </>
    ),
  },
  {
    icon: <Coins className="h-5 w-5" />,
    title: "Redeeming",
    body: (
      <>
        {/* The claim the audits flagged and the founder corrected. It is true
            and structurally so — see the card's own header comment and
            strategy/dualstake/OVERVIEW.md under "Closed since the audit". */}
        Any time, for <strong className="font-semibold text-gray-300">1 ALGO per magnetALGO plus
        the $U accrued</strong> against it. The amount is fixed per token and paid straight from
        the contract&apos;s own balance — there is no unbonding period, no queue, and no pool to
        exit through, so the size of your exit does not move the price you get. The contract
        holds enough ALGO and $U to redeem every token outstanding at once; a MainNet test
        checks that on every run rather than taking it on trust.
      </>
    ),
  },
];

/** One harvest row. */
function HarvestRow({ h }: { h: Harvest }) {
  const algo = toAlgo(h.algoMicro);
  const u = toReward(h.rewardBase);
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.05] py-2 last:border-0">
      <span className="text-[12px] text-gray-400">
        {new Date(h.timestamp * 1000).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        })}
        <span className="ml-2 text-[10.5px] text-gray-600">
          round {h.round.toLocaleString()}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[12.5px] text-gray-300">
        {num(algo, 4)} ALGO
        <span className="mx-1.5 text-gray-600">&rarr;</span>
        <span className="font-semibold text-green-400">{num(u, 5)} $U</span>
      </span>
    </div>
  );
}

export function DualStakeAbout({ snapshot, yieldRead, harvests }: {
  snapshot: DualStakeSnapshot | null;
  yieldRead: ConsensusYield | null;
  /** `null` is unread; `[]` is read-and-none-yet. They render differently. */
  harvests: Harvest[] | null;
}) {
  const [open, setOpen] = useState(false);

  // Escape closes it. The C-Vault modal predates this and should get it too;
  // not changing that file in this pass.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const net = yieldRead && snapshot
    ? netAprPct(yieldRead.grossAprPct, snapshot.platformFeeBps, snapshot.noderunnerFeeBps)
    : null;
  const perDay = yieldRead && snapshot
    ? proposalsPerDay(snapshot.stakedMicroAlgo, yieldRead.onlineStakeMicroAlgo,
      yieldRead.blockSeconds)
    : null;
  const totals = harvests ? harvestTotals(harvests) : null;
  const perAlgo = harvests ? realisedRewardPerAlgo(harvests) : null;
  const feeBps = snapshot
    ? snapshot.platformFeeBps + snapshot.noderunnerFeeBps : null;

  return (
    <>
      {/* See CvaAbout: visible words identical, accessible name specific. */}
      <button onClick={() => setOpen(true)} aria-haspopup="dialog"
        aria-label="Learn more about magnetALGO" className={RAISED_AMBER}>
        <BookOpen className="h-3.5 w-3.5" /> Learn more
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="About magnetALGO dualSTAKE"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          <div
            className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-magnet-500/20 bg-gradient-to-br from-magnet-950/90 via-[#0d0818]/95 to-magnet-950/80 shadow-2xl shadow-magnet-900/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

            <div className="flex items-center justify-between border-b border-white/5 px-6 pb-4 pt-6 sm:px-7">
              <div className="min-w-0">
                <h2 className="font-display magnet-glow-soft text-xl font-bold text-white">
                  magnetALGO
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Liquid staking on Myth Finance — what it is, how it pays, and what you carry.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="shrink-0 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[75vh] space-y-5 overflow-y-auto px-6 py-6 sm:px-7">
              {/* What it is, then how it pays, then what it costs you — the
                  order someone reads in, same as CvaAbout. */}
              <div className="grid gap-3 sm:grid-cols-2">
                {SECTIONS.map((s) => (
                  <div key={s.title} className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">
                      {s.icon}
                    </div>
                    <p className="text-sm font-semibold text-white">{s.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-400">{s.body}</p>
                  </div>
                ))}
              </div>

              {/*
                ── Where the card's number comes from ────────────────────────
                Shown in full because it is DERIVED, and because the obvious
                question about any APR on a DeFi page is "who worked that out
                and how". Myth publish no figure — their SDK README says so of
                both the listing and the state view — so the alternatives were
                to show the arithmetic or to show nothing.

                Every input is a live read, and each is printed beside the
                result so a reader can redo the multiplication.
              */}
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <div className="flex items-center gap-2">
                  <Calculator className="h-4 w-4 shrink-0 text-magnet-300" aria-hidden="true" />
                  <p className="text-sm font-semibold text-white">
                    How the rate on the card is worked out
                  </p>
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-gray-400">
                  Myth publish no APR — their SDK&apos;s own documentation says neither of its
                  contract views includes one — so this is derived from the network&apos;s current
                  parameters rather than quoted. It is what a block proposer earns per ALGO
                  staked, which does not depend on how much you or anyone else deposits:
                </p>
                {yieldRead ? (
                  <>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
                      <div>
                        <dt className="text-[10px] uppercase tracking-wider text-gray-500">Reward per block</dt>
                        <dd className="mt-0.5 font-mono text-[13px] text-gray-200">
                          {num(toAlgo(yieldRead.payoutPerBlockMicroAlgo), 4)} <span className="text-gray-500">ALGO</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wider text-gray-500">Block time</dt>
                        <dd className="mt-0.5 font-mono text-[13px] text-gray-200">
                          {yieldRead.blockSeconds.toFixed(2)} <span className="text-gray-500">s</span>
                        </dd>
                      </div>
                      <div>
                        {/* "ALGO staked network-wide" wrapped to two lines where the other
                            three labels take one, which dropped its value off the
                            row's shared baseline. The formula underneath still says
                            "staked" in full. */}
                        <dt className="text-[10px] uppercase tracking-wider text-gray-500">Network stake</dt>
                        <dd className="mt-0.5 font-mono text-[13px] text-gray-200">
                          {(toAlgo(yieldRead.onlineStakeMicroAlgo) / 1e9).toFixed(2)}<span className="text-gray-500">B</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] uppercase tracking-wider text-gray-500">Myth&apos;s fee</dt>
                        <dd className="mt-0.5 font-mono text-[13px] text-gray-200">
                          {feeBps !== null ? <>{feeBps / 100}<span className="text-gray-500">%</span></> : "—"}
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-3 border-t border-white/[0.07] pt-3 font-mono text-[11.5px] leading-relaxed text-gray-400">
                      {num(31_536_000 / yieldRead.blockSeconds / 1e6, 2)}M blocks a year
                      &times; {num(toAlgo(yieldRead.payoutPerBlockMicroAlgo), 4)} ALGO
                      &divide; {num(toAlgo(yieldRead.onlineStakeMicroAlgo) / 1e9, 2)}B staked
                      {" = "}
                      <strong className="font-semibold text-gray-200">
                        {num(yieldRead.grossAprPct, 2)}%
                      </strong>
                      {/* "less 6.5%" read as 4.77 MINUS 6.5 — which would be
                          negative — rather than as Myth's share of it. Caught
                          by reading the rendered page rather than the JSX. */}
                      {feeBps !== null && net !== null && <>
                        {" a year, of which Myth keep "}{feeBps / 100}%, leaving{" "}
                        <strong className="font-semibold text-green-400">{num(net, 2)}%</strong>
                      </>}
                    </p>
                  </>
                ) : (
                  <p className="mt-3 text-[11.5px] text-gray-500">
                    We couldn&apos;t read the network parameters just now, so no rate is shown.
                  </p>
                )}
                <p className="mt-2.5 text-[10.5px] leading-relaxed text-gray-500">
                  It is an expectation, not a promise, and it moves with the network: the reward
                  per block decreases on a published schedule, and the rate falls as more ALGO is
                  staked network-wide. It is also denominated in ALGO — you are paid the
                  equivalent in $U at whatever rate the contract converts at.
                </p>
              </div>

              {/*
                ── The realised side ─────────────────────────────────────────
                The one thing the headline cannot show: what actually
                happened. Deliberately NOT annualised, for the reason stated
                in the paragraph — and that reason is a measured figure
                (`proposalsPerDay`), not a hedge.
              */}
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                    Every harvest so far
                  </span>
                  {totals && (
                    <span className="font-mono text-[11px] text-gray-500">
                      {totals.count} total
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-gray-400">
                  Each row is one block reward, converted out of ALGO and into $U, read from the
                  contract&apos;s own event log. These amounts are what reached holders — Myth&apos;s
                  share is taken before the conversion, so nothing further comes off them.
                </p>

                <div className="mt-3">
                  {harvests === null
                    ? <p className="py-2 text-[11.5px] text-gray-500">
                        Couldn&apos;t read the harvest log just now.
                      </p>
                    : harvests.length === 0
                      ? <p className="py-2 text-[11.5px] text-gray-500">
                          No harvests recorded yet.
                        </p>
                      : harvests.slice(0, 12).map((h) => <HarvestRow key={h.round} h={h} />)}
                </div>

                {totals && perAlgo !== null && (
                  <p className="mt-3 border-t border-white/[0.07] pt-3 text-[11px] leading-relaxed text-gray-400">
                    <strong className="font-semibold text-gray-200">
                      {num(toAlgo(totals.algoMicro), 4)} ALGO
                    </strong>{" "}
                    of rewards have become{" "}
                    <strong className="font-semibold text-gray-200">
                      {num(toReward(totals.rewardBase), 5)} $U
                    </strong>
                    {/*
                      ── No day count here, deliberately ──
                      It used to read "over 1.3 days", which is the span from
                      the FIRST harvest to the LAST — a window with a harvest
                      at each end, so it excludes the dry stretch before one
                      and after the other. Dividing by it overstates the rate,
                      and the figure sat two lines from the card's 4.46%,
                      which is an invitation to do exactly that division.
                      The rows above carry their own dates; a reader who wants
                      the window can see it without being handed a biased one.
                    */}
                    {" across "}{totals.count} harvests, an average of{" "}
                    <strong className="font-semibold text-gray-200">
                      {num(perAlgo, 5)} $U per ALGO
                    </strong>{" "}
                    — the rate the contract actually achieved, slippage included, rather than a
                    quote off the pool.
                    {perDay !== null && <>
                      {" "}
                      <span className="text-gray-500">
                        This is not annualised on purpose. At the current stake the contract
                        expects to propose about {num(perDay, 1)} blocks a day, so a rate
                        extrapolated from {totals.count} of them would carry an error far larger
                        than the rate itself. The figure on the card is an expectation over the
                        network&apos;s parameters instead, which has no such problem.
                      </span>
                    </>}
                  </p>
                )}
              </div>

              {/*
                ── What you carry ───────────────────────────────────────────
                Last, because it is the part that must not be skimmed past,
                and the end of a scroll is where a reader stops rather than
                where they glance. Same reasoning and same treatment as
                CvaAbout's closing panel.

                Everything in here was on the card's face before. The amber
                disclosure paragraph is the first three bullets; the fee
                sentence is the second; the Tinyman-depth point was in
                SPEC.md and on no screen at all.
              */}
              <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.07] p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                  <p className="text-sm font-semibold text-amber-100">What you carry</p>
                </div>
                <ul className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-amber-100/80">
                  <li>
                    <strong className="font-semibold text-amber-100">This is Myth Finance&apos;s
                    contract, not ours.</strong>{" "}
                    Depositing means trusting their code and their admin keys. We have read the
                    deployed program and pinned its hash, and a test tells us the day it changes —
                    but it is not code we wrote or had audited, and the card does not present it
                    as though it were.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">They can change it, and they
                    can change the fee.</strong>{" "}
                    Upgrades run behind a one-week timelock with the new code&apos;s hash published
                    in advance, and holders who disagree can redeem immediately or formally
                    protest — materially better than most, and still an admin path.
                    {feeBps !== null
                      ? <> The fee is {feeBps / 100}% of rewards today and may rise by up to{" "}
                        {FEE_UPDATE_MAX_DELTA_BPS / 100}% a week.</>
                      : <> We couldn&apos;t read the current fee; it may rise by up to{" "}
                        {FEE_UPDATE_MAX_DELTA_BPS / 100}% a week.</>}
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">The rewards are lumpy, and
                    small stakes wait.</strong>{" "}
                    Block proposal is a lottery weighted by stake
                    {perDay !== null && <>, and the whole contract expects about{" "}
                      {num(perDay, 1)} wins a day</>}. Nothing accrues between them, so a
                    position held for a few days can see a return well above or well below the
                    rate on the card. Over long periods it converges; over short ones it does not.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">You are paid in $U, and that
                    conversion goes through a pool.</strong>{" "}
                    Rewards arrive as ALGO and are swapped into $U through the U/uALGO pool on
                    Tinyman, which held roughly $9.5K when this shipped. Slippage on that swap
                    comes out of the yield, and it grows as deposits grow. Once converted, you
                    hold $U — so its price moving is yours either way, and the rate above is the
                    ALGO-equivalent, not a guarantee of dollar value.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">The node has to stay
                    online.</strong>{" "}
                    Rewards accrue only while Myth&apos;s node is online and incentive-eligible. If
                    it drops out the yield stops until it returns; redeeming is unaffected, and
                    the card says so on its face when it happens.
                  </li>
                  <li>
                    <strong className="font-semibold text-amber-100">There is a deposit
                    ceiling.</strong>{" "}
                    The contract accepts {num(MAX_BALANCE_MICRO_ALGO / 1e6 / 1e6, 0)}M ALGO in
                    total
                    {snapshot && <> and holds {num(toAlgo(snapshot.stakedMicroAlgo), 0)} today</>}.
                    A deposit larger than the room left will not go through.
                  </li>
                </ul>
                <p className="mt-3 border-t border-amber-400/15 pt-2.5 text-[11px] text-amber-100/70">
                  magnetALGO is ASA{" "}
                  <span className="font-mono">{MAGNET_ALGO_ASA_ID}</span>.{" "}
                  <a href="https://docs.myth.finance/dualSTAKE/overview" target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-amber-100">
                    Myth&apos;s documentation
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
