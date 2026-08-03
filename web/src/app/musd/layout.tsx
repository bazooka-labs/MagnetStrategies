import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "mUSD — Magnet Strategies",
  description: "mUSD is the fully USDC-backed Magnet dollar. Mint 1:1 with no fee, redeem any time, and track the Peg Stability Module reserves.",
};

export default function MusdLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
