"use client";

/**
 * /tokens — the mUSD page, as two pills: Exchange and Governance.
 *
 * ── What this used to be ──────────────────────────────────────────────────
 * Until 2026-11-04 the two pills were ASSETS — "Magnet ($U)" and "mUSD" — and
 * the page was called Tokens. The Magnet Token view moved to /strategy, where
 * it sits beside the pools and the vault as the strategy it is, and governance
 * moved here from the foot of that view. So the pills changed kind: they name
 * two things you can DO with mUSD rather than two assets you can hold.
 *
 * ── Why the route is still /tokens ────────────────────────────────────────
 * Renaming it to /musd would mean a 301 from /tokens, and `app/strategy/page.tsx`
 * records what that costs: browsers cache permanent redirects, and the last one
 * this repo removed still misroutes anyone who visited before it went. The nav
 * label is the product's name to a visitor and the path is its name to the
 * codebase, and per CLAUDE.md they need not match. /musd already redirects here.
 */

import { type ReactNode, useEffect, useState } from "react";
import { ArrowLeftRight, Coins, Vote as VoteIcon } from "lucide-react";
import { useLiveProposalCount } from "@/hooks/useGovernanceProposals";

type Tab = "mint" | "exchange" | "governance";

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
  signal = false,
  signalLabel,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof VoteIcon;
  label: string;
  /** Draw the attention dot — something behind this pill wants a visit. */
  signal?: boolean;
  /** What the dot MEANS, for a reader who cannot see it. Required with it. */
  signalLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      /*
        `px-3` below `sm`, measured rather than guessed.

        The three pills ran 355px wide at `px-4`, against 360px of viewport
        on the narrowest phones still in use — already spilling past the
        page's 16px gutter and centred so it showed on both sides. The
        signal dot adds 14px (6px plus its gap), which tipped that into 4px
        of real horizontal page scroll at 360px. Confirmed by removing the
        dot from the live DOM and re-measuring: 369 and overflowing, 355 and
        not.

        24px comes back here, which clears it at 360 and leaves the row
        better spaced at 375 than it was before the dot existed. Full
        padding returns at `sm`, where there was never a problem.
      */
      className={`flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-colors sm:px-4 ${
        active
          ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white shadow-lg shadow-magnet-900/40"
          : "text-white/60 hover:text-white"
      }`}
    >
      {/* Glyphs, not artwork. The old pills named two assets and each had a
          mark; these name an exchange and a vote, neither of which does. */}
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
      {signal && (
        <>
          {/*
            The same dot as `LiveProposalsPill`'s, deliberately: one visual
            vocabulary for "a vote is open", whether you meet it in the hero
            or on the pill row. Size, shape and pulse are copied from there.

            It gains a halo that the hero's does not have, because it has to
            carry the message ALONE. The hero pill has a number and the word
            "proposals" beside it; here there is nothing but the dot, on a
            row the eye reads as navigation rather than as status.

            ── Why the colour flips on the active pill ──
            `bg-magnet-400` on the selected pill's magnet-600→500 gradient is
            purple on purple — the dot all but disappears at the one moment
            it is also least needed. White reads on the gradient, and keeps
            the dot a consistent OBJECT across both states rather than
            something that comes and goes with selection.
          */}
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${
              active
                ? "bg-white shadow-[0_0_6px_1px_rgba(255,255,255,0.85)]"
                : "bg-magnet-400 shadow-[0_0_7px_2px_rgba(192,132,252,0.75)]"
            }`}
          />
          {/* A dot is not readable. This makes the button announce itself as
              "Governance, a proposal is open" rather than as "Governance",
              identical to the pill beside it. */}
          <span className="sr-only">, {signalLabel}</span>
        </>
      )}
    </button>
  );
}

/**
 * Reads `window.location` directly rather than `useSearchParams`, which needs a
 * Suspense boundary and would make the build emit an EMPTY fallback into the
 * static HTML — worse than not having the deep link at all. So /tokens keeps
 * shipping full content in its statically generated markup while the links
 * below still pick a pill once the client mounts. Same reason TvlRankStat
 * fetches its own data client-side.
 *
 * ── Two ways in, because two kinds of link exist ──────────────────────────
 * `#governance` is the one that must keep working: `next.config.js` sends both
 * `/vote` and `/dao` to `/tokens#governance`, and `LiveProposalsPill` links
 * there from the Magnet Token hero on /strategy. Those were written when
 * governance was a SECTION of this page with that id, where the browser's own
 * anchor handling did the work; behind a pill there is no element to scroll to
 * until the pill is chosen, so the hash has to select it instead.
 *
 * `?tab=governance` is accepted alongside it for symmetry with /strategy's
 * `?tab=`, and because a query survives being pasted somewhere that strips
 * fragments.
 *
 * The `hashchange` listener covers the case where someone is already on this
 * page and follows a `/tokens#governance` link: Next routes that as a hash
 * change, which does not remount this component, so a mount-only read would
 * leave the Exchange pill selected under a URL claiming otherwise.
 */
/**
 * "Open the Governance pill", as a DOM event.
 *
 * Exported so the pill and this view cannot drift on the string. A same-page
 * <Link> cannot be relied on to fire `hashchange`; see the listener below.
 */
export const OPEN_GOVERNANCE = "magnet:open-governance";

export function TokensView({
  mintView,
  exchangeView,
  governanceView,
}: {
  /**
   * Added 2026-11-07. The PSM is one two-way swap; splitting it across two
   * pills means neither can be pointing the wrong way when a visitor
   * arrives. Mint leads because it is the on-ramp — the reason most people
   * open this page — and Exchange keeps the way back out.
   */
  mintView: ReactNode;
  exchangeView: ReactNode;
  governanceView: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("mint");

  /**
   * The dot on the Governance pill.
   *
   * ── Why it shares the hero pill's count rather than reading its own ──────
   * `useLiveProposalCount` is backed by one module-level store, so this is a
   * third subscriber and not a third network read. It also means the dot and
   * `LiveProposalsPill` cannot disagree: a pill row saying a vote is open
   * above a hero pill reading 0 is not a state this page can reach.
   *
   * `count > 0` even when the read came back `incomplete`, matching the hero
   * pill exactly. `incomplete` means an era could not be read, so the count
   * may be LOW — but every proposal it did count is one we actually read, so
   * a dot is still true. The hero pill prints a dash in that case because it
   * is claiming a total; a dot claims only "at least one", which survives.
   */
  const { count: liveProposals } = useLiveProposalCount();

  useEffect(() => {
    const wanted = () =>
      window.location.hash === "#governance"
      || new URLSearchParams(window.location.search).get("tab") === "governance";
    if (wanted()) setTab("governance");
    const onHash = () => { if (wanted()) setTab("governance"); };
    window.addEventListener("hashchange", onHash);

    /*
      ── Why a custom event, and not just the hash ──
      `LiveProposalsPill` is on THIS page since 2026-11-07, so pressing it is
      a same-page navigation. Next's <Link> performs that through the router's
      history API, which updates `location.hash` and **fires no `hashchange`
      event** — the listener above never runs, and the pill sets the URL while
      leaving the Exchange pill showing.

      This was measured in a real browser, not reasoned about. A jsdom test
      that dispatched `hashchange` by hand passed throughout, because the
      synthetic event is the one thing the real navigation does not produce.
      The pill therefore says what it wants explicitly rather than relying on
      a side effect of routing.

      The hash listener stays: it is what serves `/vote` and `/dao`, and an
      inbound link followed from another tab on this same page.
    */
    const onOpen = () => setTab("governance");
    window.addEventListener(OPEN_GOVERNANCE, onOpen);

    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(OPEN_GOVERNANCE, onOpen);
    };
  }, []);

  /**
   * Pick a pill AND make the URL say so.
   *
   * ── The hole this closes, which `LiveProposalsPill` moving here opened ──
   * Selecting a pill used to leave the URL alone, so a visitor who arrived at
   * `/tokens#governance` and then clicked **Exchange** sat on the Exchange
   * view under a URL still reading `#governance`. Harmless while the only
   * links in were from elsewhere.
   *
   * It stopped being harmless on 2026-11-07, when the pill moved onto this
   * page: it links to `/tokens#governance`, and from that stale state the
   * hash does not CHANGE, so no `hashchange` fires, so nothing happens. A
   * live count sitting above a button that does nothing when pressed.
   *
   * Rewriting the URL on every selection keeps it honest — which also makes
   * the page shareable from either pill — and guarantees the pill's
   * navigation is always a real transition. `replaceState` rather than
   * assigning `location.hash`: it adds no history entry, so Back still leaves
   * the page rather than cycling pills, and it fires no `hashchange`, so this
   * cannot loop through the listener above.
   */
  const select = (next: Tab) => {
    setTab(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.hash = next === "governance" ? "governance" : "";
    // The query form is accepted on the way in, so it has to be cleared on
    // the way out or it outlives the hash and contradicts the view.
    url.searchParams.delete("tab");
    window.history.replaceState(null, "", url.toString());
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Exchange / Governance toggle */}
      <div className="mb-8 flex justify-center sm:justify-start">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "mint"}
            onClick={() => select("mint")}
            icon={Coins}
            label="Mint"
          />
          <TabButton
            active={tab === "exchange"}
            onClick={() => select("exchange")}
            icon={ArrowLeftRight}
            label="Exchange"
          />
          <TabButton
            active={tab === "governance"}
            onClick={() => select("governance")}
            icon={VoteIcon}
            label="Governance"
            signal={liveProposals > 0}
            signalLabel="a proposal is open"
          />
        </div>
      </div>

      {tab === "mint" ? mintView : tab === "exchange" ? exchangeView : governanceView}
    </div>
  );
}
