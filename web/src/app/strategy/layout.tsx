import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";

/**
 * Every route supplies its own chrome.
 *
 * The ROOT layout renders no navbar — `contact`, `magnetfi`, `predict`, `trade`
 * and `tokens` each have a layout like this one. The first version of this page
 * shipped with a `page.tsx` and no layout, so it rendered with no navigation at
 * all and no way off it except the browser's back button.
 */
export const metadata: Metadata = {
  title: "Strategy — Magnet Strategies",
  description:
    "Provide liquidity to the PEX perpetuals pools and earn a share of trading fees. "
    + "Capital goes to PEX, a third-party protocol by Ultrade; Magnet Strategies holds no funds.",
};

export default function StrategyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
    </div>
  );
}
