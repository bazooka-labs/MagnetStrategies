"use client";

/**
 * Oracle health — is each feed posting, and how close is it to being unable to?
 *
 * ── Why this exists, and why it is not the whole fix ──────────────────────
 * On 2026-10-07 the U/tALGO feed stopped at 16:04Z and nobody knew for six and
 * a half hours. The vault fails closed on a stale price, so for that whole
 * window borrowing and ALL THREE LIQUIDATION PATHS were reverting on that pool
 * — a frozen lending market whose only signal was a line in a log file.
 *
 * A panel is a PULL mechanism and the failure was that nobody pulled. The
 * webhook in the oracle bot is what wakes someone; this is what they read once
 * awake, and it sits beside "Re-anchor price", which is the remedy. Detection
 * and fix in one place.
 *
 * ── The band is the part worth staring at ─────────────────────────────────
 * Age is the symptom. The band is the cause, and it is a LEADING indicator:
 * the last U/tALGO post was 0.13% under its ceiling and had been closing on it
 * for hours. Nothing in the product showed that. "Room up 1.2%" a morning
 * earlier would have turned an outage into a two-minute chore.
 *
 * The bot's own min/max bounds live in its config.json and cannot be read from
 * chain, so what is shown is the CONTRACT's ±25% anchor band — the limit that
 * survives a bot restart, and the one the button below moves.
 *
 * ── "Is it right", not just "is it fresh" ─────────────────────────────────
 * Age and band both answer liveness. Neither can see a price that is WRONG but
 * fresh, and the band — the only non-age signal here — disappears with the lean
 * oracle, which has no anchor to measure against.
 *
 * So each row also carries an independent price: third-party pool TVL divided
 * by on-chain issued LP tokens, which shares none of the bot's asset prices,
 * decimals handling or TWAP. See magnetfiPriceCheck.ts for why that is the
 * cross-check worth having and what it costs.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import algosdk from "algosdk";
import { ALGOD_URLS } from "@/lib/constants";
import { getOracleHealth, type PoolOracleHealth } from "@/lib/magnetfiReads";
import { crossCheckPools, type PriceCrossCheck } from "@/lib/magnetfiPriceCheck";
import { Panel } from "../shared";

const age = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const pct = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "" : "−"}${Math.abs(n).toFixed(1)}%`);
const px = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const divergeTone = (l: PriceCrossCheck["level"]) =>
  l === "critical" ? "text-red-300" : l === "warn" ? "text-amber-300" : l === "ok" ? "text-green-400" : "text-white/50";

function Row({ p, x }: { p: PoolOracleHealth; x?: PriceCrossCheck }) {
  const tone =
    p.level === "critical" ? "border-red-400/30 bg-red-500/[0.07]"
      : p.level === "warn" ? "border-amber-400/30 bg-amber-500/[0.07]"
      : p.nearBand ? "border-amber-400/20 bg-amber-500/[0.04]"
      : "border-white/10 bg-black/20";
  const ageTone =
    p.level === "critical" ? "text-red-300" : p.level === "warn" ? "text-amber-300" : "text-green-400";

  return (
    <div className={`rounded-xl border p-3.5 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-sm font-semibold text-white">{p.id}</p>
        <p className={`font-mono text-xs ${ageTone}`}>
          {p.ts === 0 ? "never posted" : `updated ${age(p.ageSec)} ago`}
        </p>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
        {([
          ["Price", px(p.price)],
          ["Anchor", p.anchor > 0 ? px(p.anchor) : "unset"],
          /* The two numbers that move before anything breaks. */
          ["Room up", pct(p.roomUpPct)],
          ["Room down", pct(p.roomDownPct)],
        ] as const).map(([k, v]) => (
          <div key={k}>
            <dt className="text-white/35">{k}</dt>
            <dd className="font-mono tabular-nums text-white/80">{v}</dd>
          </div>
        ))}
      </div>

      {/* The independent read. Deliberately a separate strip rather than two
          more cells above: it answers a different question from everything
          there, and it comes from outside this protocol. */}
      {x && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-white/5 pt-2 text-[11px]">
          <span className="text-white/35">Independent</span>
          <span className="font-mono tabular-nums text-white/80">
            {x.independent === null ? "—" : px(x.independent)}
          </span>
          <span className="text-white/35">Divergence</span>
          <span className={`font-mono tabular-nums ${divergeTone(x.level)}`}>
            {x.divergencePct === null ? "—" : `${x.divergencePct.toFixed(2)}%`}
          </span>
          {/* Suppressed when critical: the callout below says the same thing at
              length, and showing both reads as two findings rather than one. */}
          {x.note && x.level !== "critical" && <span className="text-white/30">{x.note}</span>}
        </div>
      )}

      {x?.level === "critical" && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The feed is fresh but disagrees with an independent read of this pool. Two very
            different things look like this: a fault in the bot&apos;s inputs (a decimals slip, a
            distorted reference pool), or a <strong>genuine move in a thin pool</strong> that the
            TWAP has not caught up with — the independent leg is spot and ours is smoothed.{" "}
            <strong>Confirm against a third source before acting.</strong> If the move is real,
            re-anchoring is the correct remedy and withholding it is what freezes the pool; if it
            is not, re-anchoring only makes a wrong price postable. Re-anchor to a price you have
            confirmed, not to this one.
          </span>
        </p>
      )}

      {p.level === "critical" && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Past the vault&apos;s 30-minute window. Borrowing <strong>and all liquidations</strong>{" "}
            are reverting on this pool. Check the bot log for &quot;refusing to post&quot;, then
            re-anchor below if the price has genuinely moved.
          </span>
        </p>
      )}
      {p.level !== "critical" && p.nearBand && (
        <p className="mt-2 text-[11px] text-amber-200/90">
          Within 5% of a band edge. When the price crosses it every post reverts and this pool
          freezes — re-anchor before that, not after.
        </p>
      )}
    </div>
  );
}

export function OracleHealthPanel() {
  const [rows, setRows] = useState<PoolOracleHealth[] | null>(null);
  const [checks, setChecks] = useState<Record<number, PriceCrossCheck>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");
      const health = await getOracleHealth(algod);
      setRows(health);
      setErr(null);
      // After, and in its own try: the cross-check depends on a third party, and
      // its failure must not cost us the freshness readout, which is the one
      // that matters during an outage.
      // Cleared first: `rows` has already been replaced above, and leaving the
      // previous tick's verdict beside a new row would present a stale judgement
      // as a current one.
      setChecks({});
      try {
        setChecks(await crossCheckPools(algod, health));
      } catch {
        setChecks({});
      }
    } catch (e) {
      // Keep the last good reading on screen; a failed read is not a stale feed.
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <Panel className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-sm font-semibold text-white">Oracle health</h3>
        <button type="button" onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-gray-400 transition-colors hover:border-white/20 hover:text-white">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {err && <p className="mt-2 text-[11px] text-amber-300/80">Could not read: {err}</p>}

      {rows === null ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading oracle…
        </p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {rows.map((p) => <Row key={p.id} p={p} x={checks[p.poolId]} />)}
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-white/30">
        Read from the oracle contract, not from the bot — a feed can stop while the process stays
        healthy. The bot&apos;s own min/max bounds live in its config and are not on chain; the band
        shown is the contract&apos;s ±25% anchor band, which is what &quot;Re-anchor price&quot;
        below moves. <span className="text-white/40">Independent</span> is pool TVL ÷ issued LP
        tokens, from sources outside this protocol — it answers whether the price is <em>right</em>,
        which age and band cannot. While a feed is stale the numbers are still shown but left{" "}
        <em>unjudged</em> — an old price diverging is expected, and the staleness alarm above has
        already fired.
      </p>
    </Panel>
  );
}
