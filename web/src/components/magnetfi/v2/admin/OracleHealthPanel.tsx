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
 * awake.
 *
 * ── What the band used to do, and what replaced it ────────────────────────
 * This panel once led with the ±25% anchor band, because it was a LEADING
 * indicator: the last U/tALGO post before that outage was 0.13% under its
 * ceiling and had been closing on it for hours.
 *
 * The band went with the banded oracle on 2026-10-17 (ORACLE_LEAN_SPEC.md §6
 * step 8). That is a real loss of signal and worth being honest about: the
 * chain no longer bounds the posted price at all. The lean oracle writes
 * whatever the bot computes.
 *
 * Be precise about what still gates a post, because two plausible answers are
 * wrong. The per-pool `min_price`/`max_price` in config.lean.json are NOT one
 * of them: `effective_bounds_with_anchor` returns (0,0,0) when the oracle has
 * no anchor (oracle_bot.py:1012), which is deliberate — a bot-side bound that
 * refuses to post is the same halt as a band that refuses to accept. And the
 * §2.2b TVL-balance invariant is NOT one either: it logs and keeps posting
 * ("this is a warning, not a gate", oracle_bot.py:887).
 *
 * What actually gates: `asset_price_bounds` on the underlying assets, the
 * CompX divergence check, and the spot-vs-TWAP upward spike block — all in
 * the bot, none readable from chain, none visible here.
 *
 * ── "Is it right", not just "is it fresh" ─────────────────────────────────
 * Age answers liveness and cannot see a price that is WRONG but fresh. With
 * the band gone it is the only on-chain signal there is, which makes the
 * independent read below the substitute rather than a supplement.
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
import { getOracleHealth, getOracleSwapState, type OracleSwapState, type PoolOracleHealth } from "@/lib/magnetfiReads";
import { crossCheckPools, type PriceCrossCheck } from "@/lib/magnetfiPriceCheck";
import { Panel, collateralGlow } from "../shared";

const age = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const px = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const divergeTone = (l: PriceCrossCheck["level"]) =>
  l === "critical" ? "text-red-300" : l === "warn" ? "text-amber-300" : l === "ok" ? "text-green-400" : "text-white/50";


function Row({ p, x }: { p: PoolOracleHealth; x?: PriceCrossCheck }) {
  const tone =
    p.level === "critical" ? "border-red-400/30 bg-red-500/[0.07]"
      : p.level === "warn" ? "border-amber-400/30 bg-amber-500/[0.07]"
      : "border-white/10 bg-black/20";
  const ageTone =
    p.level === "critical" ? "text-red-300" : p.level === "warn" ? "text-amber-300" : "text-green-400";

  return (
    <div className={`rounded-xl border p-3.5 ${tone} ${collateralGlow(p.id)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-sm font-semibold text-white">{p.id}</p>
          {/* A pool the oracle prices but nobody can borrow against yet. Without
              this the row looks like a collateral vault that has gone quiet. */}
          {!p.vaultWired && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
              oracle only
            </span>
          )}
        </div>
        <p className={`font-mono text-xs ${ageTone}`}>
          {p.ts === 0 ? "never posted" : `updated ${age(p.ageSec)} ago`}
        </p>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
        {([
          /* Anchor / Room up / Room down lived here until 2026-10-17. They
             measured the banded oracle's ±25% guard, retired with it — the
             lean oracle has no anchor, so all three were permanently blank. */
          ["Price", px(p.price)],
          ["Pool", String(p.poolId)],
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
            <strong>Confirm against a third source before acting.</strong>{" "}
            <strong>This price is already live.</strong> The banded oracle would have rejected a
            far-off post on chain; the lean oracle has no band, so whatever the bot computes is
            what the vault prices collateral against. There is nothing to re-anchor and nothing
            to wait for — if the price is wrong, stop the bot, and rotate the updater key if the
            bot itself is not trusted.
          </span>
        </p>
      )}

      {p.level === "critical" && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {p.vaultWired ? (
            <span>
              Past the vault&apos;s 30-minute window. Borrowing <strong>and all liquidations</strong>{" "}
              are reverting on this pool. Check the bot process is alive first — a power cut
              left it down 48h on 2026-10-15. If it is running, look for &quot;refusing to
              post&quot;: with the band gone that can only come from `asset_price_bounds`, the
              CompX divergence check, or the spot-vs-TWAP spike block — never from the chain.
            </span>
          ) : (
            /* Nothing can be borrowed or liquidated here yet, so the vault
               consequences do not apply — claiming they do would send someone
               hunting an outage that is not happening. It still matters: the
               feed must be healthy BEFORE this pool is registered vault-side. */
            <span>
              Past the 30-minute window. Nothing is borrowable against this pool yet, so no vault
              operation is affected — but it must be posting reliably before it is registered
              vault-side at the migration.
            </span>
          )}
        </p>
      )}
    </div>
  );
}

export function OracleHealthPanel() {
  const [rows, setRows] = useState<PoolOracleHealth[] | null>(null);
  const [pendingRows, setPendingRows] = useState<PoolOracleHealth[] | null>(null);
  const [swap, setSwap] = useState<OracleSwapState | null>(null);
  const [checks, setChecks] = useState<Record<number, PriceCrossCheck>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");
      // Which oracle the VAULT reads, not which one this build was compiled
      // against. During a migration those differ, and the vault is the fact.
      const st = await getOracleSwapState(algod);
      setSwap(st);
      const health = await getOracleHealth(algod, st.activeOracle);
      setRows(health);
      setErr(null);

      // The queued oracle has to be posting BEFORE the confirm lands, or the
      // cutover arrives into a protocol that is frozen from its first second.
      if (st.pendingOracle) {
        try {
          setPendingRows(await getOracleHealth(algod, st.pendingOracle));
        } catch { setPendingRows(null); }
      } else {
        setPendingRows(null);
      }
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
        <>
          {swap?.driftedFromConstant && (
            <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-500/5 p-2.5 text-[11px] text-amber-200/90">
              The vault is reading oracle <span className="font-mono">{swap.activeOracle}</span>, not
              the one this build was compiled against. Shown below is the oracle actually in use —
              update the constant in <span className="font-mono">magnetfi.ts</span>.
            </p>
          )}
          <div className="mt-3 space-y-2.5">
            {rows.map((p) => <Row key={p.id} p={p} x={checks[p.poolId]} />)}
          </div>

          {swap?.pendingOracle && (
            <div className="mt-5">
              <p className="mb-2 text-[11px] text-white/45">
                Queued oracle <span className="font-mono text-white/70">{swap.pendingOracle}</span> —
                confirmable {swap.pendingEtaSec
                  ? new Date(swap.pendingEtaSec * 1000).toUTCString().replace("GMT", "UTC")
                  : "once the timelock elapses"}
                . The vault still prices from the oracle above until then. Every pool here must be
                posting <em>before</em> you confirm.
              </p>
              {pendingRows === null ? (
                <p className="text-[11px] text-amber-300/80">
                  Could not read the queued oracle — do not confirm until it is readable and fresh.
                </p>
              ) : (
                <div className="space-y-2.5 opacity-90">
                  {pendingRows.map((p) => <Row key={`pending-${p.id}`} p={p} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-white/30">
        Read from the oracle contract, not from the bot — a feed can stop while the process stays
        healthy. The lean oracle enforces no price band, so nothing on chain bounds what gets
        posted, and the bot-side checks that remain are not readable here. <span className="text-white/40">Independent</span> is pool TVL ÷ issued LP
        tokens, from sources outside this protocol — it answers whether the price is <em>right</em>,
        which age cannot. While a feed is stale the numbers are still shown but left{" "}
        <em>unjudged</em> — an old price diverging is expected, and the staleness alarm above has
        already fired.
      </p>
    </Panel>
  );
}
