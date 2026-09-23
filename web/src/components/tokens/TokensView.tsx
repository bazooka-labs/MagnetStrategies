"use client";

import { type ReactNode, Suspense, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";

type Tab = "magnet" | "musd";

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
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
      <span className="h-5 w-5 shrink-0 overflow-hidden rounded-full">
        <Image src={icon} alt="" width={20} height={20} className="h-full w-full object-cover" />
      </span>
      {label}
    </button>
  );
}

// Reads the ?tab= query param client-side (rather than the page taking searchParams as a
// prop) so /tokens keeps being statically generated instead of opting into per-request
// dynamic rendering — the same reason TvlRankStat fetches its own data client-side.
function TokensViewInner({
  magnetView,
  musdView,
}: {
  magnetView: ReactNode;
  musdView: ReactNode;
}) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(searchParams.get("tab") === "musd" ? "musd" : "magnet");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Magnet / mUSD toggle */}
      <div className="mb-8 flex justify-center sm:justify-start">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "magnet"}
            onClick={() => setTab("magnet")}
            icon="/tokens/u.png"
            label="Magnet ($U)"
          />
          <TabButton
            active={tab === "musd"}
            onClick={() => setTab("musd")}
            icon="/musd-icon.png"
            label="mUSD"
          />
        </div>
      </div>

      {tab === "magnet" ? magnetView : musdView}
    </div>
  );
}

export function TokensView(props: { magnetView: ReactNode; musdView: ReactNode }) {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8" />}>
      <TokensViewInner {...props} />
    </Suspense>
  );
}
