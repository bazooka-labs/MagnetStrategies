"use client";

import { useEffect, useState } from "react";
import { RAISED_AMBER, RAISED_AMBER_ON } from "@/components/raisedButton";
import Link from "next/link";
import { Coins, Landmark, Layers, Shield } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import dynamic from "next/dynamic";
import { MagnetFiSplash } from "@/components/magnetfi/MagnetFiSplash";

type Tab = "markets" | "vaults";

/**
 * One pill in the segmented control — the tokens page's, with a lucide icon
 * instead of a token image.
 *
 * ── Why only the two TABS live in the track ────────────────────────────────
 * The row also carries mUSD and Admin, and those are not tabs: mUSD navigates
 * off the page and Admin reveals a panel on top of whichever tab is showing. A
 * segmented control makes a promise — exactly one of these is what you are
 * looking at — and putting a link inside it breaks that promise in the one way
 * a user cannot see coming. They sit on the same row, outside the track, as
 * outline pills: same visual language, different shape, honest about behaviour.
 */
function TabButton({
  active, onClick, icon: Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Landmark;
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
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}

const pulse = () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" />;

const CompXMarkets = dynamic(
  () => import("@/components/magnetfi/CompXMarkets").then((m) => m.CompXMarkets),
  { ssr: false, loading: pulse }
);

// Borrower write-tabs pull in algokit-utils — lazy-load so the default view stays light.
const VaultsTab = dynamic(
  () => import("@/components/magnetfi/v2/VaultsTab").then((m) => m.VaultsTab),
  { ssr: false, loading: pulse }
);
// The mUSD swap lives on the combined /tokens page; the mUSD link below deep-links there.

// Admin panel pulls in algokit-utils — lazy-load so it only ships when an admin opens it.
const AdminTab = dynamic(
  () => import("@/components/magnetfi/v2/AdminTab").then((m) => m.AdminTab),
  { ssr: false, loading: () => <div className="h-64 rounded-2xl border border-white/10 bg-black/40 animate-pulse" /> }
);

export default function MagnetFiPage() {
  const { address, isConnected } = useWallet();
  const isAdmin = isConnected && address === MAGNETFI_ADMIN_ADDRESS;
  const [showAdmin, setShowAdmin] = useState(false);
  // Lands on the LP vaults: they are MagnetFi's own product, where the vault,
  // PSM and oracle work we run actually lives. The lending markets are hosted
  // on CompX — worth offering, but not the thing this page is for.
  const [tab, setTab] = useState<Tab>("vaults");

  /**
   * `?tab=vaults` deep-links the LP vaults.
   *
   * Reads `window.location` directly rather than `useSearchParams`, for the
   * reason TokensView documents: `useSearchParams` needs a Suspense boundary and
   * would make the build emit an EMPTY fallback into the static HTML. Same
   * pattern, same justification — a deep link is not worth shipping a blank page
   * to get.
   */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "vaults") setTab("vaults");
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* A sibling of the content, never a parent of it: the splash blurs the
          live page behind it, and an ancestor with a running opacity animation
          would become a backdrop root and leave it blurring nothing. */}
      <MagnetFiSplash />
      {/*
        No page header here on purpose.
        ──────────────────────────────────────────────────────────────────────
        This carried a bank icon, "MagnetFi", and the line "Digital Asset
        Lending and Borrowing on Algorand". The splash says all three a second
        earlier and at full attention; repeating them in a banner the user
        scrolls past is the chrome that makes a product feel like a brochure.

        What replaces it is a control row: the two views in a segmented track,
        and the two things that are NOT views beside it.
      */}
      <div className="animate-enter mb-8 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "vaults"}
            onClick={() => setTab("vaults")}
            icon={Layers}
            label="LP Collateral Vaults"
          />
          <TabButton
            active={tab === "markets"}
            onClick={() => setTab("markets")}
            icon={Landmark}
            label="Lending Markets"
          />
        </div>

        {/* Outside the track: these ACT rather than switch view — one navigates
            away, one opens an explainer, one reveals write controls. Raised
            buttons so they read as actions next to the flat segmented track,
            which is a selector; the two should not look alike. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Learn more and mUSD moved INTO the vaults hero: a title and the
              things you can do with it should be one object, not two rows that
              happen to sit near each other. Admin stays here because it is
              page-scoped, not a property of either tab. */}
          {isAdmin && (
            <button
              onClick={() => setShowAdmin((v) => !v)}
              aria-pressed={showAdmin}
              // Amber — the colour every other "this is not ordinary browsing"
              // control uses here. Toggled ON it inverts to a pressed-in face,
              // so the row shows at a glance whether admin is open.
              className={showAdmin ? RAISED_AMBER_ON : RAISED_AMBER}
            >
              <Shield className="h-3.5 w-3.5" /> Admin
            </button>
          )}
        </div>
      </div>

      {/*
        Pre-launch banner, now scoped to the tab it is ABOUT.
        Its own comment always said "v2 vaults only" and it rendered on both,
        which was harmless while the two stacked and is misleading once they are
        tabs: a user reading it over the lending markets would think those were
        pre-launch. The second sentence used to reassure a reader of a stacked
        page that lending was live; on this tab it points at the other one.
      */}
      {!PROTOCOL_LIVE && tab === "vaults" && (
        <div className="mb-8 rounded-xl border border-magnet-500/20 bg-magnet-500/5 px-5 py-3.5 text-sm text-magnet-200">
          MagnetFi LP vaults are in final pre-launch — explore the vault types and run the numbers below.
          Single-token lending and borrowing is live now, under{" "}
          <button
            onClick={() => setTab("markets")}
            className="font-semibold underline underline-offset-2 transition-colors hover:text-white"
          >
            Lending Markets
          </button>.
        </div>
      )}

      {isAdmin && showAdmin && <div className="mb-10"><AdminTab /></div>}

      {/* One view at a time. They used to stack, which was fine with two
          sections and stops being fine as markets are added — the page would
          become a scroll rather than a product. */}
      {tab === "markets" ? <CompXMarkets /> : <VaultsTab />}
    </div>
  );
}
