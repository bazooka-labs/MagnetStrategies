import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Pools — Magnet Strategies",
  description: "Live yields on $U liquidity pools across Tinyman and Pact — trading-fee APRs plus active farm rewards, updated in real time.",
};

export default function PoolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
