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
import { ArrowLeftRight, Vote as VoteIcon } from "lucide-react";

type Tab = "exchange" | "governance";

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof VoteIcon;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white shadow-lg shadow-magnet-900/40"
          : "text-white/60 hover:text-white"
      }`}
    >
      {/* Glyphs, not artwork. The old pills named two assets and each had a
          mark; these name an exchange and a vote, neither of which does. */}
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
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
export function TokensView({
  exchangeView,
  governanceView,
}: {
  exchangeView: ReactNode;
  governanceView: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("exchange");

  useEffect(() => {
    const wanted = () =>
      window.location.hash === "#governance"
      || new URLSearchParams(window.location.search).get("tab") === "governance";
    if (wanted()) setTab("governance");
    const onHash = () => { if (wanted()) setTab("governance"); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Exchange / Governance toggle */}
      <div className="mb-8 flex justify-center sm:justify-start">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "exchange"}
            onClick={() => setTab("exchange")}
            icon={ArrowLeftRight}
            label="Exchange"
          />
          <TabButton
            active={tab === "governance"}
            onClick={() => setTab("governance")}
            icon={VoteIcon}
            label="Governance"
          />
        </div>
      </div>

      {tab === "exchange" ? exchangeView : governanceView}
    </div>
  );
}
