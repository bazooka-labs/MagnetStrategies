import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "MagnetFi — Magnet Strategies",
  description: "Borrow the mUSD stablecoin against your Tinyman LP tokens on Algorand. Your liquidity keeps earning while it works as collateral.",
};

export default function MagnetFiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
