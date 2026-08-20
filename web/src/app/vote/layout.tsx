import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "UVote — Magnet Strategies",
  description:
    "UVote — advisory, founder-led governance for Magnet Strategies. Lock $U to signal on protocol direction; reclaim it when the vote closes.",
};

export default function VoteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 pt-16">{children}</main>
      <Footer />
    </div>
  );
}
