import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "Tokens — Magnet Strategies",
  description: "$U and mUSD — price, holders, TVL, live charting, swapping, and the Peg Stability Module, all in one place.",
};

export default function TokensLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
