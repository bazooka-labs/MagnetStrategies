import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Strategy — Magnet Strategies",
  description:
    "Leveraged long and short positions on ALGO and BTC, in a few clicks. Trades execute on PEX, a third-party perpetuals protocol on Algorand.",
};

export default function StrategyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
