"use client";

// Mirrors TokensView: one page, a pill toggle across the arm's products.
// Perps is the only pill today; further products become additional pills rather
// than separate routes, so the URL and the layout stay put as the arm grows.

import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import { PerpsView } from "@/components/strategy/perps/PerpsView";

type Tab = "perps";

function TabButton({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
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
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      {label}
    </button>
  );
}

// Reads window.location directly rather than useSearchParams — same reason as
// TokensView: a Suspense boundary would emit an empty static fallback.
export function StrategyView() {
  const [tab, setTab] = useState<Tab>("perps");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "perps") setTab("perps");
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="mb-8 flex justify-center sm:justify-start">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "perps"}
            onClick={() => setTab("perps")}
            icon={<TrendingUp className="h-4 w-4" />}
            label="Perps"
          />
        </div>
      </div>

      <PerpsView />
    </div>
  );
}
