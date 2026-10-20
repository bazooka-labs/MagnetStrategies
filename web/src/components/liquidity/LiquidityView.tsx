"use client";

/**
 * Strategy — PEX liquidity provision. See web/STRATEGY_SPEC.md.
 *
 * ── Why all three cards glow purple ───────────────────────────────────────
 * On the Finance page gold means "this collateral is not $U" — it marks a
 * different risk family, which is why ALGO/USDC is the only gold vault there.
 * Here all three destinations hold the SAME collateral (ALGO + USDC), so a gold
 * card would assert a distinction that does not exist. An early mockup used gold
 * for the ALGO market and was wrong for exactly that reason.
 *
 * ── Why there is no deposit button ────────────────────────────────────────
 * v1 reads and links out; it constructs no transaction. The three PEX deposit
 * groups are materially harder than the four perps groups we already sign — two
 * asset legs, storage payments, min-share bounds and a yield-recall preamble —
 * and `perpsGroup.ts` is 2,200 lines of assertion for those four. Shipping the
 * read layer with honest numbers tells us whether anyone deposits before we
 * build signing for it. STRATEGY_SPEC.md §7.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Coins, Droplets, Layers, TrendingUp } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Panel, MAGNET_GLOW } from "@/components/magnetfi/v2/shared";
import { StrategySplash } from "./StrategySplash";
import { FEE_YIELD_DISCLAIMER, capitalStableDays } from "@/lib/pexLiquidity";
import {
  cvaShareOfMarket, readStrategyLiquidity, type StrategyLiquidity,
} from "@/lib/pexLiquidityReads";

/**
 * ⚠️ VERIFY THIS BEFORE SHIPPING.
 *
 * This read `https://pex.ultrade.org` until 2026-10-20, which **does not
 * exist** — no A record, no AAAA, HTTP fails to resolve. I invented the
 * hostname. Nothing in this repo references a PEX frontend, so there was
 * nothing to check it against, and every call-to-action on the page pointed at
 * a browser DNS error.
 *
 * `https://app.ultrade.org` is verified live (HTTP 200, titled "ULTRADE"). It
 * is Ultrade's app, which is the right destination family, but I have NOT
 * confirmed it is where PEX liquidity provision lives or that a deeper link
 * exists — so this is the host and not a guessed path. Replace with the
 * correct deep link once confirmed, and the spec's "destination preselected"
 * goal (§7.1) stays open until then: all three cards necessarily point at the
 * same place.
 */
const PEX_APP_URL = "https://app.ultrade.org";

const usd = (v: number | null, dp = 0) =>
  v === null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pct = (v: number | null, dp = 1) => (v === null ? "—" : `${v.toFixed(dp)}%`);
const num = (v: number | null, dp = 0) =>
  v === null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** The page's sections. One today; the track exists because more are coming. */
type Tab = "pools";

/**
 * One pill, identical to the Finance and Tokens tracks.
 *
 * Deliberately a real segmented control rather than a heading, even with a
 * single option: a track that gains its second tab is a one-line change, and a
 * heading that has to become a track later is a rewrite. The active pill still
 * reads as selected, so it looks like a chosen view rather than a dead control.
 */
function TabButton({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: typeof Droplets; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white shadow-lg shadow-magnet-900/40"
          : "text-white/60 hover:text-white"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

/** A yield figure that is NOT a return gets a muted tone, never green-as-reward. */
function YieldFigure({ value, caption }: { value: number | null; caption: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Fee APR</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="font-mono text-[32px] font-semibold leading-none tracking-tight text-white">
          {pct(value)}
        </span>
        {/* "fees only" sits AT the number. The callout below is three
            card-heights past the first deposit button on a phone — too late to
            qualify a 32px figure. PEX forbids labelling this APY, and theirs is
            "fees + yield"; ours omits yield, so it says fees. */}
        <span className="text-[11px] text-gray-400">fees only</span>
      </div>
      <p className="mt-1.5 text-[11px] text-gray-400">{caption}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] text-gray-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-gray-200">{value}</dd>
    </div>
  );
}

/** ALGO vs USDC split. Lightness differs as well as hue, so it reads without colour. */
function Composition({ longShare, longLabel, shortLabel }: {
  longShare: number | null; longLabel: string; shortLabel: string;
}) {
  if (longShare === null) {
    return <p className="text-[10.5px] text-gray-500">Pool is empty — no composition to show.</p>;
  }
  const l = Math.round(longShare * 100);
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[10.5px] text-gray-500">
        <span>Composition</span>
        <span className="font-mono">{l}% / {100 - l}%</span>
      </div>
      <div className="flex h-[7px] overflow-hidden rounded-full bg-white/[0.06]">
        <div className="bg-amber-400" style={{ width: `${l}%` }} />
        <div className="bg-sky-400" style={{ width: `${100 - l}%` }} />
      </div>
      <div className="mt-1.5 flex gap-3.5 text-[10.5px] text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-sm bg-amber-400" />{longLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-sm bg-sky-400" />{shortLabel}
        </span>
      </div>
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return <Panel glowClass={MAGNET_GLOW} className="p-5">{children}</Panel>;
}

function GoToPex({ label }: { label: string }) {
  return (
    <a
      href={PEX_APP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-magnet-900/40 transition-all hover:from-magnet-500 hover:to-magnet-400"
    >
      {label} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

export function LiquidityView() {
  const { algodClient, address } = useWallet();
  const [data, setData] = useState<StrategyLiquidity | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!algodClient) return;
    try {
      // ALGO price: the short leg is USDC so it needs no mark, but the long leg
      // does. Same source the terminal's chart strip already uses.
      const r = await fetch("https://api.exchange.coinbase.com/products/ALGO-USD/ticker");
      const algoUsd = Number((await r.json()).price);
      if (!Number.isFinite(algoUsd) || algoUsd <= 0) throw new Error("no ALGO price");
      setData(await readStrategyLiquidity(algodClient, algoUsd, address));
      setErr(null);
    } catch (e) {
      // `data` is CLEARED, not left standing.
      //
      // This previously set `err` and kept the last successful read on screen,
      // under a banner reading "Figures below are omitted rather than
      // guessed" — directly contradicted by the figures below it. The path is
      // easy to hit: the page loads, the user connects a wallet, `load` re-runs
      // because `address` is a dependency, the ALGO price fetch 429s, and every
      // pool size and share price on screen is now from before.
      setData(null);
      setErr(e instanceof Error ? e.message : "Could not read pool state");
    }
  }, [algodClient, address]);
  useEffect(() => { void load(); }, [load]);

  const m = (id: "algo-usd" | "btc-usd") => data?.markets.find((x) => x.id === id) ?? null;
  const [tab, setTab] = useState<Tab>("pools");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* A SIBLING of the content, never a parent of it: the splash blurs the
          live page behind it, and an ancestor with a running opacity animation
          becomes a backdrop root, leaving it blurring nothing. Same placement
          as /magnetfi — see ArrivalSplash's header. */}
      <StrategySplash />
      <div className="animate-enter mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-white">Strategy</h1>
          {/* ── Why this no longer says "depositing raises the ceiling" ──
              It was false. Open interest is capped by TWO things: a per-market
              `max_open_interest_long/short` risk parameter that PEX's admin
              sets, and a pool-derived reserve check (30% of OI value must be
              covered by the pool). Depositing moves the second and does
              nothing to the first. When this was checked, market 1 sat at
              $2,195.60 of long OI against a $2,200.00 admin cap — $4.40 of
              headroom — so a $10,000 deposit would have raised tradable OI by
              $4.40 and no further. Promising a ceiling increase a depositor
              cannot influence is the worst thing this page could claim. */}
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-400">
            These pools are the capital traders on the terminal trade against. Deposits earn a share
            of trading fees and take the other side of every position. Open interest is separately
            capped per market by PEX, so a deposit does not by itself raise the trading ceiling.
          </p>
        </div>
        <div className="flex gap-2.5">
          <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Total liquidity</div>
            <div className="mt-0.5 font-mono text-lg font-semibold text-white">
              {usd(data?.totals.totalUsd ?? null)}
            </div>
            {/* The split, shown because it is the proof the total is not
                double-counted: the C-Vault's capital is a SLICE of the pools,
                not an addition to them. */}
            {data && (
              <div className="mt-1 text-[10px] text-gray-500">
                {usd(data.totals.directUsd)} direct · {usd(data.totals.viaCvaUsd)} via C-Vault
              </div>
            )}
          </div>
          <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Live</div>
            <div className="mt-0.5 font-mono text-lg font-semibold text-white">
              {data ? `${Math.round(data.days)} days` : "—"}
            </div>
          </div>
        </div>
      </div>

      {err && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-xs text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Could not read pool state: {err}. Figures below are omitted rather than guessed.</span>
        </div>
      )}

      <div className="animate-enter mb-7 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-sm">
          <TabButton
            active={tab === "pools"}
            onClick={() => setTab("pools")}
            icon={Droplets}
            label="Pools"
          />
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        {/* ── C-Vault ── */}
        <CardShell>
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-2.5">
              <div>
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />
                  <h2 className="text-[17px] font-bold text-white">C-Vault</h2>
                </div>
                <p className="mt-1.5 text-[11.5px] text-gray-500">Managed by PEX · spans both markets</p>
              </div>
              <span className="shrink-0 rounded-full border border-magnet-500/30 bg-magnet-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-magnet-300">
                AUTO
              </span>
            </div>

            <YieldFigure
              value={data?.cva.blendedFeeYieldPct ?? null}
              caption={data && data.cva.ratedMarkets < data.cva.totalMarkets
                // The blend renormalises onto the markets it can rate, which
                // is upward-biased — so say so rather than present a partial
                // blend as the whole picture.
                ? `Only ${data.cva.ratedMarkets} of ${data.cva.totalMarkets} markets could be rated`
                : "Weighted by what the vault holds in each pool"}
            />

            <div className="h-px bg-white/[0.07]" />

            <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
              <Stat label="Vault NAV" value={usd(data?.cva.navUsd ?? null)} />
              <Stat label="Markets" value={num(data?.cva.allocations.length ?? null)} />
              <Stat label="Your shares" value={num(data?.cva.yourShares ?? null, 4)} />
              <Stat label="Rebalanced" value="by PEX" />
            </dl>

            <div className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2.5 text-[10.5px] leading-relaxed text-gray-500">
              Takes <strong className="font-semibold text-gray-300">ALGO + USDC</strong>. You do not pick a
              market — the vault allocates across both and rebalances itself.
              {/* The managed option is the only one with a fixed entry/exit cost
                  and a lock, and a page comparing three destinations that showed
                  its APR but not its spread would flatter it. Values are PEX's
                  own globals on app 3690309167. */}
              <span className="mt-1.5 block text-gray-400">
                Costs <strong className="font-semibold text-gray-300">0.2% in and 0.2% out</strong>,
                with a ~1 hour withdrawal cooldown and a $5 minimum withdrawal. The direct pools
                have no such spread.
              </span>
            </div>

            <GoToPex label="Deposit on PEX" />
          </div>
        </CardShell>

        {/* ── the two market pools ── */}
        {(["algo-usd", "btc-usd"] as const).map((id) => {
          const mk = m(id);
          const slice = data && mk ? cvaShareOfMarket(data, mk.marketId) : null;
          return (
            <CardShell key={id}>
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-2.5">
                  <div>
                    <div className="flex items-center gap-2">
                      {id === "algo-usd"
                        ? <Coins className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />
                        : <TrendingUp className="h-5 w-5 shrink-0 text-magnet-400" aria-hidden="true" />}
                      <h2 className="text-[17px] font-bold text-white">
                        {mk?.label ?? (id === "algo-usd" ? "ALGO/USD" : "BTC/USD")}
                      </h2>
                    </div>
                    <p className="mt-1.5 text-[11.5px] text-gray-500">
                      Direct LP · market {mk?.marketId ?? (id === "algo-usd" ? 1 : 2)}
                      {mk?.synthetic ? " · synthetic" : ""}
                    </p>
                  </div>
                  {slice !== null && (
                    <span className="shrink-0 rounded-full border border-magnet-500/30 bg-magnet-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-magnet-300">
                      {Math.round(slice * 100)}% C-VAULT
                    </span>
                  )}
                </div>

                <YieldFigure
                  value={mk?.fees.annualisedPct ?? null}
                  caption={mk
                    ? `${usd(mk.fees.feesUsd, 2)} of fees over ${Math.round(mk.fees.days)} days`
                    : "Fees not read"}
                />

                <div className="h-px bg-white/[0.07]" />

                <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
                  <Stat label="Pool size" value={usd(mk?.value.totalUsd ?? null)} />
                  <Stat label="Pool / share" value={usd(mk?.poolValuePerShare ?? null, 4)} />
                  <Stat label="Your shares" value={num(mk?.yourShares ?? null, 4)} />
                  <Stat label="Share supply" value={num(mk?.shareSupply ?? null, 0)} />
                </dl>

                {/* Open interest against PEX's admin-set cap. Without this a
                    depositor cannot see that a market is full — market 1 sat at
                    99.8% of its cap when this shipped, so capital added there
                    bought almost no additional tradable size. */}
                {mk && (
                  <div>
                    <div className="mb-1.5 flex justify-between text-[10.5px] text-gray-500">
                      <span>Long OI vs PEX cap</span>
                      <span className="font-mono">
                        {usd(mk.oi.longUsd)} / {usd(mk.oi.capLongUsd)}
                      </span>
                    </div>
                    <div className="flex h-[7px] overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className={mk.oi.utilisation !== null && mk.oi.utilisation > 0.9
                          ? "bg-amber-400" : "bg-magnet-500"}
                        style={{ width: `${Math.min(100, (mk.oi.utilisation ?? 0) * 100)}%` }}
                      />
                    </div>
                    {mk.oi.utilisation !== null && mk.oi.utilisation > 0.9 && (
                      <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber-300/90">
                        This market is at {pct(mk.oi.utilisation * 100, 0)} of its cap. The cap is set
                        by PEX and a deposit does not raise it.
                      </p>
                    )}
                  </div>
                )}

                {/* Suppressed, not footnoted, when the legs are not what we
                    think: `micro()` assumes 6 decimals on both and the long leg
                    is priced as ALGO, so a changed asset makes the bar and the
                    pool size confidently wrong rather than slightly off. */}
                {mk && !mk.legsVerified ? (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2.5 text-[10.5px] leading-relaxed text-amber-200">
                    This market&apos;s assets no longer read as ALGO/USDC on chain, so the
                    composition and pool size are not shown — they would be wrong rather than
                    approximate.
                  </div>
                ) : (
                <Composition
                  longShare={mk?.value.longShare ?? null}
                  longLabel={mk ? `${num(mk.legs.longAmount)} ALGO` : "ALGO"}
                  shortLabel={mk ? `${num(mk.legs.shortAmount)} USDC` : "USDC"}
                />
                )}

                <div className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2.5 text-[10.5px] leading-relaxed text-gray-500">
                  {mk?.syntheticVerified
                    ? <>BTC exposure, backed with <strong className="font-semibold text-gray-300">ALGO + USDC</strong> — there is no BTC in this pool.</>
                    : <>Takes <strong className="font-semibold text-gray-300">ALGO + USDC</strong>, both legs.</>}
                </div>

                <GoToPex label="Add liquidity on PEX" />
              </div>
            </CardShell>
          );
        })}
      </div>

      {/* The caveat. Not a footnote: it is the difference between a yield and a return. */}
      <div className="mt-7 flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.055] px-5 py-4">
        <AlertTriangle className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber-300" aria-hidden="true" />
        <div>
          <p className="text-[12.5px] font-semibold text-amber-300">
            These are fee yields, not expected returns
          </p>
          <p className="mt-1.5 max-w-4xl text-[11.5px] leading-relaxed text-gray-300">
            These annualise trading fees accrued on chain since the first deposit into each pool,
            against the pool&apos;s current capital. No LP has added or removed capital for{" "}
            {Math.floor(capitalStableDays())} days, so that denominator is the capital that earned
            those fees — but capital was still arriving over the first two weeks, which makes the
            figure <em className="text-gray-200">understate</em> the realised rate. It also excludes
            the external-yield income PEX credits to these pools, understating it again.
            {" "}{FEE_YIELD_DISCLAIMER} As an LP you are the counterparty to every trade, so a quiet market with winning traders can leave you down while the fee line
            still reads positive. &quot;Pool / share&quot; above is pool value divided by shares — it is
            <em className="text-gray-200"> not</em> PEX&apos;s NAV per share, which also carries trader
            profit and loss, so do not read it as a performance figure. Figures use today&apos;s pool
            size across the whole period and exclude any fees already withdrawn.
          </p>
          <p className="mt-2 text-[11px] text-gray-500">
            Capital goes to PEX, a third-party protocol by Ultrade. Magnet Strategies holds no funds and
            operates no exchange. PEX has had no external audit.
          </p>
        </div>
      </div>
    </div>
  );
}
