import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "About — Magnet Strategies",
  description: "Magnet Strategies is an Algorand-native DeFi organization built to attract and compound liquidity, with the $U token at the center of MagnetFi, mUSD, and Magnet Farms.",
};

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
