"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ArrowDownUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/hooks/useWallet";
import { PROTOCOL_LIVE, pct, formatUsd } from "@/lib/magnetfi";
import { makeAlgorand, optIn, mintMusd, redeemMusd } from "@/lib/magnetfiClient";
import { getBalances, getProtocolStats, MUSD_ID, USDC_ID, REDEEM_FEE_BPS, type Balances } from "@/lib/magnetfiReads";
import { PrimaryButton, NotLiveNote, tokenIcon } from "./shared";

/**
 * The protocol's two directions.
 *
 * ── "redeem" here, "Exchange" on screen, deliberately ────────────────────
 * The contract call is `redeemMusd` and the fee is `REDEEM_FEE_BPS`; those
 * are what the PSM does and renaming them would put a UI word on a protocol
 * term, which is how a codebase stops matching its own contracts.
 *
 * The screen says Exchange (2026-11-07). "Redeem" asks a reader to know that
 * mUSD is a claim on a reserve before the label makes sense, and the pill
 * that gets them here already says Exchange — two words for one action, one
 * of them jargon.
 */
type Mode = "mint" | "redeem";

function AssetBadge({ asset }: { asset: string }) {
  const icon = tokenIcon(asset);
  return (
    <span className="flex items-center gap-1.5 rounded-lg bg-surface-lighter px-3 py-1.5 text-sm font-semibold text-white">
      {icon && (
        <span className="h-4 w-4 overflow-hidden rounded-full shrink-0">
          <Image src={icon} alt="" width={16} height={16} className="h-full w-full object-cover" />
        </span>
      )}
      {asset}
    </span>
  );
}

/**
 * `fixed` locks the direction and hides the flip control (2026-11-07).
 *
 * The PSM is one two-way swap, and a visitor arriving to buy mUSD had to
 * notice a small flip button to find out which way it was pointing. Split
 * across two pills — Mint for USDC -> mUSD, Exchange for mUSD -> USDC —
 * each is a single text box and a single button, and neither can be
 * pointing the wrong way when you arrive.
 *
 * One component, not two: the contract calls, opt-in handling, balance
 * guards and the PSM-reserve check are the same on both sides, and a copy
 * would be the half that stops getting fixes.
 */
export function MusdTab({ fixed, subtitle, peg, headingAs = "p" }: {
  fixed?: Mode;
  /** A line under the panel's heading. Moved in from the page header. */
  subtitle?: string;
  /** mUSD/USDC market price, shown inside the card. Null renders a dash. */
  peg?: number | null;
  /**
   * The element the heading renders as.
   *
   * A `<p>` everywhere this panel sits under a page that has its own `<h1>`
   * — the Mint tab and the Finance page both do. The Exchange tab dropped
   * its page header on 2026-11-08 because it duplicated this heading word
   * for word, which left that page with no level-one heading at all; it
   * passes `"h1"` so the one remaining title is the real one. An `sr-only`
   * copy in the view would have read the same words out twice instead.
   *
   * Visual size is unchanged either way: it is set here, not by the tag.
   */
  headingAs?: "h1" | "p";
} = {}) {
  const { address, isConnected, algodClient, transactionSigner } = useWallet();
  /**
   * ── `fixed` is DERIVED, never seeded into state ─────────────────────────
   * The obvious form — `useState(fixed ?? "mint")` — is wrong here, and
   * wrong in a way that compiles and renders.
   *
   * Mint and Exchange are both `<MusdTokenView>` at the same position in the
   * tree, so switching pills does not remount: React reconciles them as the
   * same instance and only updates props. An initial-state read happens once
   * and never again, so Exchange rendered the heading "Redeem mUSD" over a
   * panel still pointing USDC -> mUSD. Caught by switching tabs in a browser.
   *
   * Deriving on every render makes the prop authoritative. `freeMode` is only
   * consulted when nothing is fixed, which is the two-way PSM panel.
   */
  const [freeMode, setFreeMode] = useState<Mode>("mint");
  const mode = fixed ?? freeMode;
  const [amount, setAmount] = useState("");
  const [bal, setBal] = useState<Balances | null>(null);
  const [psmUsdc, setPsmUsdc] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const algorand = useMemo(
    () => (algodClient && transactionSigner ? makeAlgorand(algodClient, transactionSigner) : null),
    [algodClient, transactionSigner]);

  const refresh = useCallback(() => {
    if (!PROTOCOL_LIVE || !algodClient) return;
    if (address) getBalances(algodClient, address).then(setBal).catch(() => {});
    getProtocolStats(algodClient).then((s) => setPsmUsdc(s.psmUsdc)).catch(() => {});
  }, [algodClient, address]);
  useEffect(() => { refresh(); }, [refresh]);

  const amt = Math.max(0, Number(amount) || 0);
  const fee = mode === "mint" ? 0 : amt * (REDEEM_FEE_BPS / 10_000);
  const out = amt - fee;
  const fromAsset = mode === "mint" ? "USDC" : "mUSD";
  const toAsset = mode === "mint" ? "mUSD" : "USDC";

  async function run() {
    if (!algorand || !address) return;
    setBusy(true);
    try {
      // Fetch balances if not loaded yet so a required opt-in is never skipped (H-2).
      let b = bal;
      if (!b && algodClient) b = await getBalances(algodClient, address);
      if (mode === "mint") {
        if (b && !b.optedMusd) { await optIn(algorand, address, MUSD_ID); toast.success("Opted into mUSD"); }
        await mintMusd(algorand, address, amt);
        toast.success(`Minted ${formatUsd(out)} mUSD`);
      } else {
        if (b && !b.optedUsdc) { await optIn(algorand, address, USDC_ID); toast.success("Opted into USDC"); }
        await redeemMusd(algorand, address, amt);
        toast.success(`Exchanged for ${formatUsd(out)} USDC`);
      }
      refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Transaction failed";
      toast.error(m.includes("rejected") ? "Signing cancelled" : m.slice(0, 140));
    } finally { setBusy(false); }
  }

  const insufficient = !!bal && PROTOCOL_LIVE &&
    (mode === "mint" ? bal.usdc < amt : bal.musd < amt);
  // Redeem cannot exceed the PSM's USDC reserve (M-1).
  const lowReserve = mode === "redeem" && psmUsdc !== null && amt > psmUsdc;

  const Heading = headingAs;

  return (
    <div className="p-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading className="font-display text-base font-semibold text-white">
            {fixed === "mint" ? "Mint mUSD" : fixed === "redeem" ? "Exchange mUSD" : "Stablecoin Swap"}
          </Heading>
          {/* The line that used to sit under the page header. It belongs to
              the trade, not to the page, so it moved in with it. */}
          {subtitle && <p className="mt-1 text-xs leading-relaxed text-gray-400">{subtitle}</p>}
        </div>

        {/* The peg, square, beside the heading.

            It sits in the slot the direction pill used to hold — the two do
            not both fit, and on this panel the direction is already stated
            twice: the heading says Exchange mUSD and the strapline says
            "back to USDC". On Mint and on the two-way panel the pill is the
            only direction marker there is, so it stays. */}
        {peg !== undefined && (
          <div className="flex h-[120px] w-[120px] shrink-0 flex-col items-center justify-center rounded-xl border border-white/10 bg-black/30 px-3 text-center">
            <p className="text-[10px] font-medium uppercase leading-tight tracking-wider text-gray-500">
              mUSD peg
            </p>
            <p className="mt-1.5 font-mono text-xl font-bold leading-none text-green-400">
              {peg === null ? "—" : `$${peg.toFixed(4)}`}
            </p>
            {/* Allowed to wrap: at 120px the attribution fits on one line
                today, and a longer source name should stack rather than
                overflow the square. */}
            <p className="mt-1.5 text-[10px] leading-tight text-gray-500">Market price via Vestige</p>
          </div>
        )}
        {/* `shrink-0 whitespace-nowrap`: the heading block grew a strapline
            under it on 2026-11-07, and the badge started wrapping onto two
            lines — "mUSD →" over "USDC", which reads as a broken arrow. */}
        {peg === undefined && (
          <span className="shrink-0 whitespace-nowrap rounded-full border border-white/10 bg-black/40 px-2.5 py-1 font-mono text-[11px] text-gray-400">
            {fromAsset} → {toAsset}
          </span>
        )}
      </div>

      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-medium uppercase tracking-wider text-gray-500">You pay</label>
        {bal && PROTOCOL_LIVE && (
          <span className="flex items-center gap-2 text-xs text-gray-500">
            Balance: {formatUsd(mode === "mint" ? bal.usdc : bal.musd)} {fromAsset}
            <button type="button" onClick={() => setAmount(String(mode === "mint" ? bal.usdc : bal.musd))}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-magnet-300 hover:text-magnet-200">
              Max
            </button>
          </span>
        )}
      </div>
      <div className="flex items-center rounded-xl border border-white/10 bg-black/40 px-4 focus-within:border-magnet-500/50">
        <input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)}
          className="w-full bg-transparent px-1 py-3.5 font-mono text-xl text-white outline-none" placeholder="0" />
        <AssetBadge asset={fromAsset} />
      </div>

      {/*
        ── One box on a fixed pill, and the figure on the button ───────────
        A read-only output box is a field you cannot type in, sitting under
        one you can, restating a number the button is about to act on. On a
        two-way swap it earns its place: it is where the direction reads. On
        Mint or Exchange the direction is the pill, so the box was a second
        thing to look at and a flip control that must not be pressed.

        Both go. What you pay is the only input, and what you get is on the
        button you press to get it: "Mint: 10.00 mUSD".
      */}
      {!fixed && (
        <>
          <div className="my-2 flex justify-center">
            <button type="button" onClick={() => setFreeMode((m) => (m === "mint" ? "redeem" : "mint"))}
              aria-label="Switch swap direction"
              className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-magnet-300 transition-all hover:border-magnet-500/50 hover:bg-magnet-500/10 hover:text-magnet-200">
              <ArrowDownUp className="h-4 w-4 transition-transform duration-300 group-hover:rotate-180" />
            </button>
          </div>

          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">You receive</label>
          <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-4">
            <input readOnly value={out ? formatUsd(out) : "0.00"}
              className="w-full bg-transparent px-1 py-3.5 font-mono text-xl text-white outline-none" />
            <AssetBadge asset={toAsset} />
          </div>
        </>
      )}

      <div className="mt-5 space-y-2 rounded-xl border border-white/5 bg-black/20 p-4 text-sm">
        <div className="flex justify-between"><span className="text-gray-400">Rate</span>
          <span className="font-mono text-white">1 {fromAsset} = 1 {toAsset}</span></div>
        {/* The ceiling, before you hit it (2026-11-07).

            `lowReserve` already refused an oversized exchange — but only on
            the button, after an amount was typed. The PSM's USDC is what
            caps a redemption, the number was already fetched for that
            guard, and `Current Available` lives on the Finance page, so
            there was no way to size a trade from here at all.

            Redeem side only: minting is capped by `max_balance`, not by
            this reserve, and showing it there would answer a question
            nobody on that tab is asking. */}
        {mode === "redeem" && (
          <div className="flex justify-between"><span className="text-gray-400">PSM reserve</span>
            <span className="font-mono text-white">
              {psmUsdc === null ? "…" : `${formatUsd(psmUsdc)} USDC`}
            </span></div>
        )}
        <div className="flex justify-between"><span className="text-gray-400">Fee</span>
          <span className="font-mono text-white">
            {mode === "mint" ? "0%" : `${pct(REDEEM_FEE_BPS)}%`}{fee > 0 && <span className="text-gray-500"> · {formatUsd(fee)} USDC</span>}
          </span></div>
      </div>

      <div className="mt-5">
        {/* Taller on a fixed pill: with the output box gone the button is
            the main object on the panel, and at the default height it read
            as a footnote under a short form. */}
        <PrimaryButton tall={!!fixed} onClick={run} disabled={!PROTOCOL_LIVE || !isConnected || busy || amt <= 0 || insufficient || lowReserve}>
          {busy ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Confirm in wallet…</span>
            : !isConnected ? "Connect wallet"
            : !PROTOCOL_LIVE ? "Launching on mainnet soon"
            : insufficient ? `Insufficient ${fromAsset}`
            : lowReserve ? "Exceeds PSM reserve"
            /* The figure rides on the button when the panel has no output
               box: the amount and the act of committing to it are one
               thing to read. Bare verb until there is something to quote —
               "Mint: 0.00 mUSD" on an empty, disabled button reads as a
               broken quote rather than an empty form. */
            : fixed && amt > 0 ? `${fixed === "mint" ? "Mint" : "Exchange"}: ${formatUsd(out)} ${toAsset}`
            : fixed ? (fixed === "mint" ? "Mint" : "Exchange")
            : mode === "mint" ? "Mint mUSD" : "Exchange mUSD"}
        </PrimaryButton>
        {!PROTOCOL_LIVE && <NotLiveNote />}
      </div>
    </div>
  );
}
