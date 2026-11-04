"use client";

/**
 * A deliberately plain surface for proving the ALGO-collateral path with real
 * money, away from the trading terminal.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every check on the ALGO path passes in simulation. Simulation is not a
 * signature — CLAUDE.md says so, and this repo has the scars: several defects
 * on the liquidity path were invisible to tests and obvious the moment a real
 * wallet tried to sign. Protective orders and limit entries stay refused for
 * ALGO because no keeper has been observed executing an ALGO-denominated fee,
 * and nothing here changes that.
 *
 * So the sequence is: prove an open and a close here, with small amounts, then
 * put the toggle in front of users.
 *
 * ── The gate is a real check, not a hidden link ─────────────────────────────
 * The nav entry is hidden from everyone else, but hiding a link is a
 * convenience and not a boundary: the route is public and anyone can type it.
 * So this component refuses to BUILD anything unless the connected wallet is
 * the admin address. That is still not a security boundary — the on-chain
 * authority is the signature, and PEX would happily accept these groups from
 * any wallet — it is there so the page cannot be used by accident.
 *
 * ── No bells and whistles, on purpose ───────────────────────────────────────
 * No slider, no chart, no bar, no protection legs. Those are the parts of the
 * real card most likely to disagree with what gets signed, and this page
 * exists to test the SIGNING path, not the composing one.
 */

import { useMemo, useState } from "react";
import algosdk from "algosdk";
import { useWallet } from "@/hooks/useWallet";
import { usePerpsMarket } from "@/hooks/usePerpsMarket";
import { usePerpsPositions } from "@/hooks/usePerpsPositions";
import { openPosition, closePosition } from "@/lib/strategy/perps/client";
import { quoteOpen } from "@/lib/strategy/pex/quote";
import { collateralUsd as collateralUsdOf } from "@/lib/strategy/pex/collateral";
import {
  ACTIVE_MARKET_ID, BUILDER_ADDRESS, DEFAULT_SLIPPAGE_BPS,
  PEX_ASSETS, assetName,
} from "@/lib/strategy/pex/config";
import { MAGNETFI_ADMIN_ADDRESS } from "@/lib/magnetfi";
import { ALGOD_URLS } from "@/lib/constants";
import type { Side } from "@/lib/strategy/perps/solver";

const MARKET = ACTIVE_MARKET_ID;

export function AdminCollateralTest() {
  const wallet = useWallet();
  const isAdmin = wallet.isConnected && wallet.address === MAGNETFI_ADMIN_ADDRESS;

  const { data } = usePerpsMarket(MARKET);
  const { positions, refresh } = usePerpsPositions(isAdmin ? wallet.address : null);

  const [collateralAssetId, setCollateralAssetId] = useState<number>(PEX_ASSETS.algo);
  const [amount, setAmount] = useState("");
  const [notional, setNotional] = useState("");
  const [side, setSide] = useState<Side>("long");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const say = (line: string) =>
    setLog((l) => [`${new Date().toISOString().slice(11, 19)}  ${line}`, ...l].slice(0, 40));

  const amountMicro = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : BigInt(0);
  })();
  const notionalUsd = Number(notional);

  /**
   * The quote, which this page needs for one reason only: `openPosition`
   * REQUIRES the values that were on screen, and refuses to build against
   * numbers it computed itself. See `OpenPositionInput.displayed`.
   */
  const quote = useMemo(() => {
    if (!data || amountMicro <= BigInt(0) || !Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      return null;
    }
    try {
      return quoteOpen({
        state: data.state, oracle: data.oracle, side,
        collateralAmountMicro: amountMicro, notionalUsd,
        builderAddress: BUILDER_ADDRESS, collateralAssetId,
        algoPrice12: data.oracle.indexPrice12,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
    } catch (e) {
      return { ok: false, reasons: [(e as Error).message] } as never;
    }
  }, [data, amountMicro, notionalUsd, side, collateralAssetId]);

  const collateralUsd = (() => {
    if (!data || amountMicro <= BigInt(0)) return null;
    try {
      return collateralUsdOf(collateralAssetId, amountMicro, data.oracle.indexPrice12);
    } catch { return null; }
  })();

  async function doOpen() {
    if (!isAdmin || !wallet.address || !data || !quote?.ok) return;
    setBusy("opening");
    try {
      say(`open ${side} ${amount} ${assetName(collateralAssetId)} -> $${notional} notional`);
      const r = await openPosition({
        algod: new algosdk.Algodv2("", ALGOD_URLS.mainnet, ""),
        signTransactions: (t) => wallet.signTransactions(t),
        sender: wallet.address,
        marketId: MARKET, side,
        collateralAssetId, collateralAmountMicro: amountMicro,
        algoPrice12: data.oracle.indexPrice12,
        notionalUsd,
        takeProfitPrice12: BigInt(0),
        stopLossPrice12: BigInt(0),
        slippageBps: DEFAULT_SLIPPAGE_BPS,
        displayed: {
          asRenderedIndexPrice12: data.oracle.indexPrice12,
          asRenderedEntryPrice12: quote.entryPrice12,
          asRenderedLiquidationPrice12: quote.liquidationPrice12,
          asRenderedNetCollateralMicro: BigInt(Math.round(quote.netCollateralUsd * 1e6)),
          asRenderedLeverage: quote.leverage,
        },
        onStage: (s) => say(`  stage: ${s}`),
      });
      say(`RESULT ${r.outcome} tx=${r.txId}${r.reason ? ` reason=${r.reason}` : ""}`);
      r.checks.forEach((c) => say(`  checked: ${c}`));
      refresh();
    } catch (e) {
      say(`FAILED ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function doClose(p: (typeof positions)[number]) {
    if (!isAdmin || !wallet.address || !p.close?.ok) return;
    setBusy("closing");
    try {
      say(`close ${p.side} ${assetName(p.collateralAssetId)} market ${p.marketId}`);
      const r = await closePosition({
        algod: new algosdk.Algodv2("", ALGOD_URLS.mainnet, ""),
        signTransactions: (t) => wallet.signTransactions(t),
        sender: wallet.address,
        marketId: p.marketId, side: p.side,
        collateralAssetId: p.collateralAssetId,
        sizeUsdMicro: p.position.size_usd,
        position: p.position,
        quote: p.close,
        onStage: (s) => say(`  stage: ${s}`),
      });
      say(`RESULT ${r.outcome} tx=${r.txId}`);
      refresh();
    } catch (e) {
      say(`FAILED ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (!wallet.isConnected) {
    return <p className="text-sm text-gray-400">Connect the admin wallet.</p>;
  }
  if (!isAdmin) {
    return (
      <p className="text-sm text-gray-400">
        This page builds nothing unless the connected wallet is the admin address.
      </p>
    );
  }

  const field = "w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white";
  const pill = (on: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
      on ? "border-white/40 bg-white/10 text-white" : "border-white/10 text-white/50 hover:text-white/80"}`;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-[12px] text-amber-200/90">
        Real money, MainNet. Market orders only, no take-profit or stop — those
        stay refused on ALGO collateral until a keeper is observed executing an
        ALGO-denominated fee. Start small.
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-gray-500">Collateral</label>
          <div className="flex gap-2">
            {[PEX_ASSETS.algo, PEX_ASSETS.usdc].map((id) => (
              <button key={id} type="button" className={pill(collateralAssetId === id)}
                onClick={() => setCollateralAssetId(id)}>
                {assetName(id)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-gray-500">Side</label>
          <div className="flex gap-2">
            {(["long", "short"] as const).map((s) => (
              <button key={s} type="button" className={pill(side === s)} onClick={() => setSide(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-gray-500">
            Collateral amount ({assetName(collateralAssetId)})
          </label>
          <input className={field} value={amount} inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          {collateralUsd !== null && (
            <p className="mt-1 text-[11px] text-gray-500">≈ ${collateralUsd.toFixed(2)}</p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-gray-500">
            Notional (USD)
          </label>
          <input className={field} value={notional} inputMode="decimal"
            onChange={(e) => setNotional(e.target.value)} placeholder="0.00" />
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-[12px]">
        {quote === null ? (
          <span className="text-gray-500">Enter an amount and a notional.</span>
        ) : quote.ok ? (
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <span className="text-gray-400">Leverage <span className="font-mono text-white">{quote.leverage.toFixed(4)}×</span></span>
            <span className="text-gray-400">Entry <span className="font-mono text-white">{(Number(quote.entryPrice12) / 1e12).toFixed(6)}</span></span>
            <span className="text-gray-400">Liquidation <span className="font-mono text-white">{(Number(quote.liquidationPrice12) / 1e12).toFixed(6)}</span></span>
            <span className="text-gray-400">Backing <span className="font-mono text-white">${quote.netCollateralUsd.toFixed(4)}</span></span>
          </div>
        ) : (
          <span className="text-red-300">PEX refuses: {quote.reasons.join(", ")}</span>
        )}
      </div>

      <button type="button" onClick={doOpen} disabled={!quote?.ok || !!busy}
        className="rounded-lg border border-white/25 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
        {busy === "opening" ? "Opening…" : "Open position"}
      </button>

      <div>
        <h3 className="mb-2 text-[11px] uppercase tracking-wider text-gray-500">Open positions</h3>
        {positions.length === 0 && <p className="text-[12px] text-gray-500">None.</p>}
        <div className="space-y-2">
          {positions.map((p) => (
            <div key={`${p.marketId}-${p.collateralAssetId}-${p.side}`}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-[12px]">
              <span className="font-semibold text-white">
                {p.side} · {assetName(p.collateralAssetId)} · market {p.marketId}
              </span>
              <span className="font-mono text-white/70">
                size ${(Number(p.position.size_usd) / 1e6).toFixed(2)}
              </span>
              <span className="font-mono text-white/70">
                collateral {(Number(p.position.collateral_amount) / 1e6).toFixed(4)} {assetName(p.collateralAssetId)}
              </span>
              <button type="button" onClick={() => doClose(p)} disabled={!p.close?.ok || !!busy}
                className="ml-auto rounded-lg border border-white/25 px-3 py-1.5 font-semibold text-white disabled:opacity-40">
                {busy === "closing" ? "Closing…" : "Close"}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[11px] uppercase tracking-wider text-gray-500">Log</h3>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/40 p-3 text-[11px] leading-relaxed text-gray-300">
{log.length ? log.join("\n") : "—"}
        </pre>
      </div>
    </div>
  );
}
