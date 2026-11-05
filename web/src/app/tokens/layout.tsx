import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";

export const metadata: Metadata = {
  title: "mUSD — Magnet Strategies",
  description: "mUSD — the peg, backing, holders, live charting, the Peg Stability Module, and protocol governance.",
};

export default function TokensLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
    </div>
  );
}
