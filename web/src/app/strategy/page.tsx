import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export const metadata = {
  title: "Strategy — Magnet Strategies",
  description: "DeFi strategy products: leveraged positions, strategy vaults and advanced trading.",
};

const PRODUCTS = [
  {
    name: "Perps",
    body: "Leveraged long or short on ALGO and BTC, in a few clicks. Trades execute on PEX, a third-party perpetuals protocol — Magnet writes no contract and holds no funds.",
    href: "/strategy/perps",
    status: "live" as const,
  },
  {
    name: "CLMM strategy pools",
    body: "Automated liquidity vaults on concentrated-liquidity markets. Waiting on the underlying platform.",
    href: null,
    status: "planned" as const,
  },
  {
    name: "Advanced trading",
    body: "For people who want the full instrument rather than the simplified one.",
    href: null,
    status: "planned" as const,
  },
];

export default function StrategyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">Strategy</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/50">
        Products where you take a position or deploy capital into an engineered
        strategy — as opposed to the Bank, where you deposit or borrow at a posted rate.
      </p>

      <div className="mt-7 space-y-3">
        {PRODUCTS.map((p) => {
          const inner = (
            <>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-white">{p.name}</h2>
                {p.status === "live" ? (
                  <span className="rounded-full border border-green-400/30 bg-green-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-green-300">Live</span>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/40">Planned</span>
                )}
                {p.href && <ArrowUpRight className="ml-auto h-4 w-4 text-white/30" />}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-white/50">{p.body}</p>
            </>
          );
          return p.href ? (
            <Link key={p.name} href={p.href}
              className="block rounded-2xl border border-white/10 bg-black/40 p-4 transition-colors hover:border-magnet-400/40">
              {inner}
            </Link>
          ) : (
            <div key={p.name} className="rounded-2xl border border-white/[0.06] bg-black/20 p-4 opacity-60">{inner}</div>
          );
        })}
      </div>
    </main>
  );
}
