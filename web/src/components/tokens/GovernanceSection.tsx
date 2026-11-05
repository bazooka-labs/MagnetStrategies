"use client";

/**
 * mVote — the mUSD page's "Governance" pill.
 *
 * ── Where it has lived ─────────────────────────────────────────────────────
 * It was /vote, a nav entry of its own. One proposal had ever been opened, and
 * a standing nav entry that usually leads to "check back when the founder opens
 * the first vote" costs more than it buys, so it became a section at the foot
 * of the $U page. On 2026-11-04 it became a pill on the mUSD page instead: $U
 * moved under /strategy.
 *
 * ── The pivot IS done ──────────────────────────────────────────────────────
 * Voting is weighted by mUSD, through mVote — a separate contract, because
 * `musd_asa_id` is fixed at creation and the $U app could never be repointed.
 * UVote is retired: readable for its one closed proposal, writable never.
 *
 * The mechanism copy below therefore says mUSD, and that is load-bearing in
 * the same way the old $U copy was — it describes what the wallet will be
 * asked to lock. `tokensGovernance.test.ts` fails if it drifts.
 *
 * Until the App ID is pasted into governance.ts the page says voting is
 * landing and every write path refuses. That is a real state, not a stub.
 *
 * It is a PILL rather than a section for the first time here. As a section it
 * carried its empty state onto a page about something else, which is why it
 * was kept at the very bottom; a pill shows it only to a reader who asked.
 *
 * ── Why "How voting works" is permanent and not a modal ────────────────────
 * It was briefly an `AboutModal`, matching how the token blurbs explain
 * themselves. Wrong call: those modals answer a question a reader may already
 * know the answer to, while this one explains a mechanism that locks their
 * tokens for seven days. Rules you must understand BEFORE acting do not belong
 * one click away. It keeps the amber treatment so it still reads as the page's
 * informative voice.
 *
 * ── The treasury is NOT here ───────────────────────────────────────────────
 * It is the fifth metric box at the top of both tabs now. It used to be a panel
 * beside "How it works", and showing the same balance twice on one page would
 * invite the reader to wonder which one is current.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Info, ShieldCheck, Sparkles, Vote as VoteIcon } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { AdminPanel } from "@/components/vote/AdminPanel";
import { ProposalCard } from "@/components/vote/ProposalCard";
import { getVotingBalance } from "@/lib/governanceReads";
import { useGovernanceProposals } from "@/hooks/useGovernanceProposals";
import { getFounder } from "@/lib/governanceReads";
import {
  GOVERNANCE_LIVE, GOVERNANCE_ADMIN_ADDRESS, MVOTE, formatWeight, isActive,
} from "@/lib/governance";

export function GovernanceSection() {
  const { address, isConnected, algodClient } = useWallet();
  /**
   * Who the CONTRACT says is founder, not who this file hard-codes.
   *
   * Gating on the constant meant a founder transfer left the new founder with
   * no admin panel and the old one still looking at controls whose calls the
   * contract would reject. Authority lives on chain; ask it.
   *
   * Falls back to the constant when there is nothing to ask — before deploy
   * there is no founder, and that is exactly when the Deploy button has to be
   * reachable.
   */
  const [founder, setFounder] = useState<string | null>(null);
  const [founderKnown, setFounderKnown] = useState(false);
  useEffect(() => {
    if (!algodClient || !MVOTE.appId) { setFounder(null); setFounderKnown(false); return; }
    let alive = true;
    void getFounder(algodClient, MVOTE).then((f) => {
      if (!alive) return;
      setFounder(f);
      setFounderKnown(f !== null);
    });
    return () => { alive = false; };
  }, [algodClient]);

  /*
    Once the chain has ANSWERED, it decides. Before that it cannot.

    `founder ?? CONSTANT` collapsed three states into two: not deployed (where
    the constant is right, and is what makes the Deploy button reachable), read
    in flight, and read failed. In the last two it handed the panel to the
    hard-coded address — so after a founder transfer the OLD admin kept seeing
    controls whose calls the contract rejects, on any blip.

    Falling back while unknown is still the lesser evil: this panel is
    cosmetic, real authority is enforced on chain, and locking the legitimate
    founder out of it during a slow read helps nobody. But the fallback now
    says so on screen rather than passing itself off as verified.
  */
  const isAdmin = isConnected
    && address === (founderKnown ? founder : GOVERNANCE_ADMIN_ADDRESS);
  const founderUnverified = isAdmin && MVOTE.appId > 0 && !founderKnown;

  /**
   * The proposals come from the shared store, not a fetch of our own: the hero
   * pill counts the same list, and two reads would be two numbers that can
   * disagree about whether a vote is open.
   */
  const { proposals, loading, incomplete, refresh } = useGovernanceProposals();
  /**
   * The voter's mUSD, as three distinct states.
   *
   * `null` alone conflated "still loading" with "the read failed", so every
   * wallet connect briefly announced "Couldn't read your balance". Zero is a
   * fourth, separate answer and means they hold none.
   */
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceState, setBalanceState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  /** Only the newest balance read may write, for the reason ProposalCard documents. */
  const balanceSeq = useRef(0);

  const loadBalance = useCallback(async () => {
    const seq = ++balanceSeq.current;
    if (!algodClient || !address) {
      setBalance(null);
      setBalanceState("idle");
      return;
    }
    setBalance(null);          // clear FIRST: A's figure must not sit under B
    setBalanceState("loading");
    const b = await getVotingBalance(algodClient, address, MVOTE);
    if (seq !== balanceSeq.current) return;
    setBalance(b);
    setBalanceState(b === null ? "error" : "loaded");
  }, [algodClient, address]);
  /** Admin tooling is opt-in even for the admin — it is not what they come here to read. */
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => { void loadBalance(); }, [loadBalance]);

  /** After a vote or a claim: re-read the proposals AND this wallet's balance. */
  const load = useCallback(() => {
    refresh();
    void loadBalance();
  }, [refresh, algodClient, address]);

  /*
   * Live: soonest to close first — the one with a deadline is the one that
   * needs a decision. History: most recently ended first, so the newest result
   * is at the top and the list grows downward into the past.
   */
  // `era.accepting` as well as the window, matching `liveCount` exactly. Without
  // it the pill and this list could disagree about what is open — the pill
  // filtered on both and this did not.
  const live = proposals
    .filter((p) => p.era.accepting && isActive(p))
    .sort((a, b) => a.endTime - b.endTime);
  const history = proposals
    .filter((p) => !(p.era.accepting && isActive(p)))
    .sort((a, b) => b.endTime - a.endTime);

  /**
   * Re-render on a timer so a window closing is noticed.
   *
   * Open-vs-closed is computed from the browser clock at render time, and
   * nothing re-rendered this tree when that crossed `endTime`. A card left open
   * across the deadline kept its vote buttons live and sent the voter into a
   * prompt the chain was always going to reject.
   *
   * 15s rather than 1s: the boundary is approximate anyway — the contract reads
   * `Global.latest_timestamp()`, the previous block's time, not the voter's
   * clock — so the goal is to stop the page being minutes stale, not to be
   * exact. The remaining skew is unavoidable and is why a near-deadline action
   * can still be refused.
   */
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    /* No top margin: as a section this needed one to clear the pools above it;
       as a pill it is the first thing in the column and TokensView already
       spaces the toggle off it. `scroll-mt-24` stays — `/vote` and `/dao`
       still redirect to `/tokens#governance`. */
    <section id="governance" className="scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <VoteIcon className="h-5 w-5 text-magnet-400" />
          <h2 className="font-display text-xl font-bold text-white">Governance</h2>
        </div>

        {/* Admin, as a pill — the same treatment MagnetFi gives its own, and
            invisible to everyone else. */}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setAdminOpen((v) => !v)}
            aria-expanded={adminOpen}
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:border-amber-400/50 hover:bg-amber-500/15 hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Admin
          </button>
        )}
      </div>

      {isAdmin && adminOpen && (
        <div className="mb-6 space-y-3">
          {founderUnverified && (
            <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
              Couldn&apos;t read the contract&apos;s founder, so these controls are shown on the
              configured admin address rather than a verified one. If founder was transferred,
              these calls will be rejected on chain.
            </p>
          )}
          <AdminPanel onProposalCreated={load} founder={founder} />
        </div>
      )}

      {/*
        ── The $U -> mUSD pivot, as a state rather than a promise ───────────
        This slot used to say "governance is moving to mUSD" while the contract
        still locked $U. It has moved: mVote is a separate contract with
        `musd_asa_id` fixed at creation, and UVote is retired.

        The notice now appears ONLY in the gap between the contract being
        written and its App ID being pasted into governance.ts — a real state
        the site can be in, during which nobody can vote and saying so is the
        whole job. Once live there is nothing to announce: the rules below say
        mUSD, and each historical card carries its own "UVote · weighted by $U"
        badge, which is a better place for that fact than a page-level banner
        a reader has to remember while scrolling.
      */}
      {!GOVERNANCE_LIVE && (
        <div className="mb-5 rounded-2xl border border-magnet-400/25 bg-magnet-500/[0.06] p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-magnet-300" />
            <h3 className="font-display text-base font-semibold text-magnet-200">
              mUSD governance is landing
            </h3>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-gray-400">
            Voting moves from $U to <strong className="font-semibold text-gray-300">mUSD</strong>. The
            contract is written and tested; it is not deployed yet, so no vote can be cast right now and
            the rules below describe what happens when it is. $U-weighted voting has ended — the closed
            proposal under it stays on this page as history.
          </p>
        </div>
      )}

      {/* ── How voting works ──────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.06] p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 shrink-0 text-amber-300" />
          <h3 className="font-display text-base font-semibold text-amber-200">How voting works</h3>
        </div>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-gray-400">
          <p>
            The Founder posts an open question that impacts a particular outcome of Magnet
            Strategies. Holders can then exercise their voice by utilizing held mUSD,
            signaling their preference on the open proposal.
          </p>
          <p>
            Only whole mUSD can be used, where one mUSD is equal to one vote in weight.
            It is accepted as voting power by being locked within the voting contract, and
            remains locked for the remainder of the voting window.
          </p>
          <p>
            Your mUSD — and a small refundable box deposit — come back in full when the vote closes.
            Nothing can take them in between: the contract has no sweep path, and mUSD has no freeze
            or clawback address, so a reclaim cannot be blocked by anyone, including us.
          </p>
        </div>

        {/* Vote power, full width inside the explanation.
            It sits HERE rather than in the header row because the number only
            means anything next to the sentence that says one whole token is one
            vote. As a lone pill it was a figure without a unit. */}
        <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-5 py-4">
          {/* White label, Magnet-purple figure — the inverse of the metric row
              above, where the label is grey and the colour carries the number.
              Here the box sits inside an amber panel, so a grey label would
              read as disabled against it. */}
          <p className="text-xs font-medium uppercase tracking-wider text-white">
            Current vote power
          </p>
          <p className="mt-1.5 font-mono text-2xl font-bold text-magnet-400">
            {!isConnected || balance === null
              ? "—"
              : `${formatWeight(MVOTE, balance)} ${MVOTE.unit}`}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {!isConnected
              ? "Connect a wallet to see your voting power"
              : balanceState === "loading"
                ? "Reading your balance…"
                : balanceState === "error"
                  // Not "0 mUSD", and not silence. A failed read is not a balance.
                  ? "Couldn't read your balance just now — withheld rather than guessed"
                  : `Whole ${MVOTE.unit} only — fractions do not count toward a vote`}
          </p>
        </div>
      </div>

      {/* ── Live proposals ────────────────────────────────────────────────── */}
      <h3 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-widest text-gray-500">
        Live proposals
      </h3>
      {/* A read failed, so the list below may be missing something. Said out
          loud, because an incomplete list and an empty one look identical. */}
      {incomplete && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Couldn&apos;t read every proposal just now, so this list may be incomplete.{" "}
            <button onClick={refresh} className="underline underline-offset-2 hover:text-amber-100">
              Try again
            </button>
          </span>
        </div>
      )}

      {!GOVERNANCE_LIVE ? (
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-magnet-400" />
          <p className="mt-3 text-sm font-medium text-white">mUSD governance is launching soon</p>
          <p className="mt-1 text-xs text-gray-500">
            {isAdmin ? "Deploy the contract to open governance." : "Governance opens once the contract is live."}
          </p>
        </div>
      ) : loading ? (
        <p className="py-12 text-center text-sm text-gray-500">Loading proposals…</p>
      ) : live.length === 0 ? (
        /* Named, not blank. A reader who cannot tell the difference between
           "nothing to vote on" and "this is broken" assumes the latter. */
        <div className="rounded-2xl border border-white/10 bg-black/30 px-6 py-12 text-center">
          <VoteIcon className="mx-auto h-8 w-8 text-gray-600" />
          <p className="mt-3 text-sm font-medium text-white">
            {incomplete ? "Couldn't load the proposals" : "Nothing to vote on right now"}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {incomplete
              ? "We couldn't read every proposal just now, so there may be one open that is not shown."
              : "There are no live proposals. Holding mUSD is what gives you a vote when the next one opens."}
          </p>
        </div>
      ) : (
        /* Full width and stacked rather than two across: a proposal is a
           question with choices and a tally, and halving its width wrapped the
           question before the reader got to the options. */
        <div className="space-y-4">
          {live.map((p) => (
            <ProposalCard key={`${p.era.key}-${p.id}`} proposal={p}
              balance={p.era.key === MVOTE.key ? balance : null} onChanged={load} />
          ))}
        </div>
      )}

      {/* ── Voting history ────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <>
          <h3 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-widest text-gray-500">
            Voting history
          </h3>
          <div className="space-y-4">
            {/* Keyed by era too: proposal ids restart at 1 in the new contract,
                so `id` alone collides across the two. */}
            {history.map((p) => (
              // Only the mUSD era gets the mUSD balance. Passing it to a
              // $U-weighted card would be the wrong token's figure the moment
              // anything there could open a vote modal.
              <ProposalCard key={`${p.era.key}-${p.id}`} proposal={p}
                balance={p.era.key === MVOTE.key ? balance : null} onChanged={load} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
