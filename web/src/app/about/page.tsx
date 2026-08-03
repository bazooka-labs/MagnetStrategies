import Link from "next/link";
import { Coins, Landmark, CircleDollarSign, Sprout, ArrowRight, ArrowUpRight } from "lucide-react";

const FARM_URL = "https://app.tinyman.org/pool/AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI";

const PRODUCTS = [
  {
    icon: <Coins className="h-5 w-5" />, name: "$U — the Magnet Token",
    body: "The asset at the center. A fixed-supply Algorand token whose value tracks the strategies it powers.",
    href: "/token", cta: "Token dashboard", external: false,
  },
  {
    icon: <Landmark className="h-5 w-5" />, name: "MagnetFi — the Bank",
    body: "Borrow mUSD against LP collateral that keeps earning, plus single-token money markets.",
    href: "/magnetfi", cta: "Open the Bank", external: false,
  },
  {
    icon: <CircleDollarSign className="h-5 w-5" />, name: "mUSD — the Magnet dollar",
    body: "A fully USDC-backed stablecoin. Mint 1:1 with no fee, redeem any time.",
    href: "/musd", cta: "Mint & redeem", external: false,
  },
  {
    icon: <Sprout className="h-5 w-5" />, name: "Magnet Farms",
    body: "Liquidity incentives on Algorand DEXes — earn trading fees and rewards on approved pools.",
    href: FARM_URL, cta: "Provide liquidity", external: true,
  },
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
      {/* Hero — the thesis */}
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/40 px-6 py-12 backdrop-blur-sm sm:px-12 sm:py-16">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
        <div className="animate-blob-drift pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-magnet-600/20 blur-3xl" />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-widest text-magnet-300">About</p>
          <h1 className="magnet-glow-soft mt-3 font-display text-4xl font-bold leading-tight text-white sm:text-5xl">
            Attract liquidity.<br />Put it to work.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-gray-300">
            Magnet Strategies is an Algorand-native DeFi organization built to attract and compound liquidity, with the{" "}
            <span className="font-semibold text-white">$U</span> token at the center of everything we build. The goal is
            simple: outperform a plain ALGO hold over time — by putting capital to work across Algorand DeFi and
            reinvesting the returns into $U&apos;s underlying value. We build for the long run, through cycles.
          </p>
        </div>
      </section>

      {/* How it fits together — the ecosystem hub */}
      <section className="mt-14">
        <div className="mb-6 max-w-2xl">
          <h2 className="font-display text-2xl font-bold text-white">How it fits together</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">
            $U sits at the center and each product feeds the others — it collateralizes MagnetFi loans, anchors farm
            pairs, and accrues value from the fees generated across every layer. A self-reinforcing loop, not four
            separate apps.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {PRODUCTS.map((p) => (
            <div key={p.name} className="flex flex-col rounded-2xl border border-white/10 bg-black/40 p-6 backdrop-blur-sm transition-colors hover:border-magnet-500/30">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-magnet-600 to-magnet-800 text-white">{p.icon}</div>
              <h3 className="font-display text-base font-semibold text-white">{p.name}</h3>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-gray-400">{p.body}</p>
              {p.external ? (
                <a href={p.href} target="_blank" rel="noopener noreferrer"
                  className="mt-4 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-magnet-300 transition-colors hover:text-magnet-200">
                  {p.cta} <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              ) : (
                <Link href={p.href}
                  className="mt-4 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-magnet-300 transition-colors hover:text-magnet-200">
                  {p.cta} <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Risk disclosure */}
      <section className="mt-14">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Important risk disclosure</h2>
        <p className="mt-3 max-w-3xl text-xs leading-relaxed text-gray-600">
          DeFi involves significant risk — including smart-contract vulnerabilities, impermanent loss, market
          volatility, and governance uncertainty. Past performance is not indicative of future results. Do your own
          research and only commit what you can afford to lose.
        </p>
      </section>

      {/* Close — contact */}
      <div className="mt-12 flex flex-col items-start gap-3 border-t border-white/5 pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-400">Questions, partnerships, or feedback?</p>
        <Link href="/contact"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-4 py-2 text-sm font-semibold text-magnet-200 transition-colors hover:border-magnet-500/40 hover:text-white">
          Get in touch <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
