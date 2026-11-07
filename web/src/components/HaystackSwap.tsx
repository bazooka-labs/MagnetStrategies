"use client"

import { useState, useEffect, useRef } from "react"
import { RouterClient } from "@txnlab/haystack-router"
import type { SwapQuote } from "@txnlab/haystack-router"
import { useWallet } from "@/hooks/useWallet"
import { toast } from "sonner"

const USDC_ID = 31566704
const MAGNET_ID = 3081853135
const MAGNET_FACTOR = 100_000

/**
 * What a visitor can pay with, and what they land on by default.
 *
 * ── ALGO leads, since 2026-11-07 ──────────────────────────────────────────
 * This panel offered USDC only. The product's whole claim is that $U beats
 * holding vanilla ALGO, so the swap a reader of this page is most likely to
 * want is the one that acts on that claim — and presenting the stablecoin
 * route first asked them to arrive already holding USDC.
 *
 * USDC stays, because plenty of people do arrive holding it; it is a second
 * option rather than the only one.
 *
 * `0` is ALGO to Haystack's router — its README's own convention, and
 * verified against the live router before this shipped: 10 ALGO quoted
 * 6.78886 $U at a −0.15% impact, which also agrees with the 0.676 $U/ALGO
 * the dualSTAKE contract realises on its own harvests.
 */
const PAY_ASSETS = {
  ALGO: { id: 0, factor: 1_000_000, label: "ALGO" },
  USDC: { id: USDC_ID, factor: 1_000_000, label: "USDC" },
} as const
type PayAsset = keyof typeof PAY_ASSETS
const DEFAULT_PAY: PayAsset = "ALGO"
/**
 * Haystack Router key.
 *
 * ── This is NOT a secret, and it is not ours ──
 * `1b72df7e-…` is TxnLab's own FREE-TIER key, printed verbatim in the
 * @txnlab/haystack-router README's "API Key Tiers" table and shared by every
 * app that uses the default. It is stated here because it has twice been
 * mistaken for a leaked credential — it sits in a `"use client"` component, so
 * it has always shipped in the browser bundle at /tokens and has always been
 * readable by any visitor. There is nothing to rotate and nothing to hide.
 * Moving it to NEXT_PUBLIC_* would not change that; client-side env vars ship
 * in the bundle too.
 *
 * ── What IS worth doing ──
 * The free tier is 60 requests/min SHARED across everyone using the default
 * key, which is a rate-limit contention risk in production, not a security
 * one. TxnLab issue dedicated production keys on request
 * (support@txnlab.dev). The env var below exists so one can be dropped in
 * without touching this file; the free-tier key stays as the fallback.
 */
const HAYSTACK_KEY =
  process.env.NEXT_PUBLIC_HAYSTACK_KEY || "1b72df7e-1131-4449-8ce1-29b79dd3f51e"

const router = new RouterClient({ apiKey: HAYSTACK_KEY, autoOptIn: true })

export function HaystackSwap() {
  const { isConnected, activeAddress, transactionSigner, wallets } = useWallet()

  const [pay, setPay] = useState<PayAsset>(DEFAULT_PAY)
  const [amountIn, setAmountIn] = useState("")
  const [previewOut, setPreviewOut] = useState<number | null>(null)
  const [priceImpact, setPriceImpact] = useState<number | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [showWallets, setShowWallets] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestQuoteRef = useRef<SwapQuote | null>(null)

  const asset = PAY_ASSETS[pay]

  useEffect(() => {
    const micro = Math.round(parseFloat(amountIn) * asset.factor)
    if (!amountIn || isNaN(micro) || micro <= 0) {
      setPreviewOut(null)
      setPriceImpact(null)
      latestQuoteRef.current = null
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setQuoteLoading(true)
      try {
        const q = await router.newQuote({
          fromASAID: asset.id,
          toASAID: MAGNET_ID,
          amount: micro,
          address: activeAddress ?? undefined,
        })
        latestQuoteRef.current = q
        setPreviewOut(Number(q.quote) / MAGNET_FACTOR)
        setPriceImpact(q.userPriceImpact ?? null)
      } catch {
        setPreviewOut(null)
        setPriceImpact(null)
        latestQuoteRef.current = null
      } finally {
        setQuoteLoading(false)
      }
    }, 500)
    /* `asset.id` and `asset.factor`, not `asset`: the object is rebuilt on
       every render, so depending on it re-ran the quote in a loop. */
  }, [amountIn, activeAddress, asset.id, asset.factor])

  async function handleSwap() {
    if (!isConnected || !activeAddress || !transactionSigner) return
    const micro = Math.round(parseFloat(amountIn) * asset.factor)
    if (!amountIn || isNaN(micro) || micro <= 0) return

    setSwapping(true)
    try {
      const q = await router.newQuote({
        fromASAID: asset.id,
        toASAID: MAGNET_ID,
        amount: micro,
        address: activeAddress,
      })
      const swap = await router.newSwap({
        quote: q,
        address: activeAddress,
        signer: transactionSigner,
        slippage: 1,
      })
      await swap.execute()
      toast.success("Swap successful!")
      setAmountIn("")
      setPreviewOut(null)
      setPriceImpact(null)
      latestQuoteRef.current = null
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Swap failed"
      toast.error(msg)
    } finally {
      setSwapping(false)
    }
  }

  const canSwap = isConnected && !!previewOut && !swapping && !quoteLoading

  return (
    <div className="flex flex-col gap-4 p-5">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-left">Swap</p>

      {/* What you pay with. ALGO first — see PAY_ASSETS.

          A real segmented control rather than the static label this used to
          be: the label looked like a caption, and a caption does not invite a
          click. Switching CLEARS the amount, because "10" means something
          different in each asset and carrying it over would re-quote a figure
          the user never typed for this side.

          ── Two of the lines below are REDUNDANT, and stay ──
          Said plainly because the mutation run says so. Clearing the amount
          is what the tests catch; nulling the preview and the impact
          survived removal on their own, because the empty amount makes the
          effect null them a tick later anyway. Removing BOTH does turn the
          tests red, which was run and confirmed.

          They stay for the tick in between: React re-renders with the amount
          gone while the old asset's output figure is still on screen, so for
          one frame "6.78886" sits under a label now reading USDC. Too brief
          for jsdom to catch and perfectly visible to a person.

          The same applies to `asset.id`/`asset.factor` in the effect's deps:
          unnecessary only because switching clears the amount. If that clear
          ever goes, the deps are the only thing left stopping a quote for the
          wrong asset. */}
      <div role="tablist" aria-label="Asset to pay with"
        className="inline-flex self-start rounded-full border border-white/10 bg-black/40 p-0.5">
        {(Object.keys(PAY_ASSETS) as PayAsset[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={pay === k}
            onClick={() => {
              if (k === pay) return
              setPay(k)
              setAmountIn("")
              setPreviewOut(null)
              setPriceImpact(null)
              latestQuoteRef.current = null
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              pay === k
                ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white"
                : "text-white/50 hover:text-white"
            }`}
          >
            {PAY_ASSETS[k].label}
          </button>
        ))}
      </div>

      {/* Pay input */}
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 flex items-center gap-3">
        <span className="text-sm font-semibold text-gray-400 w-12 shrink-0">{asset.label}</span>
        <input
          type="number"
          min="0"
          placeholder="0.00"
          aria-label={`${asset.label} to swap`}
          value={amountIn}
          onChange={(e) => setAmountIn(e.target.value)}
          className="flex-1 bg-transparent text-white text-right text-lg font-bold placeholder-white/20 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
      </div>

      {/* Arrow */}
      <div className="flex justify-center text-gray-600 -my-1 text-lg select-none">↓</div>

      {/* $U output */}
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 flex items-center gap-3">
        <span className="text-sm font-semibold text-magnet-400 w-12 shrink-0">$U</span>
        <span className="flex-1 text-right text-lg font-bold">
          {quoteLoading ? (
            <span className="text-gray-500 text-sm">fetching…</span>
          ) : previewOut !== null ? (
            <span className="text-white">{previewOut.toFixed(5)}</span>
          ) : (
            <span className="text-white/20">0.00000</span>
          )}
        </span>
      </div>

      {/* Price impact */}
      {priceImpact !== null && (
        <p className="text-xs text-right -mt-2">
          Price impact:{" "}
          <span className={priceImpact > 3 ? "text-red-400" : "text-gray-400"}>
            {priceImpact.toFixed(2)}%
          </span>
        </p>
      )}

      {/* Action */}
      {!isConnected ? (
        <div className="relative">
          <button
            onClick={() => setShowWallets((v) => !v)}
            className="w-full rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-3 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 transition-all duration-150"
          >
            Connect Wallet
          </button>
          {showWallets && (
            <div className="absolute bottom-full mb-2 left-0 right-0 rounded-lg border border-white/10 bg-[#0d0015] p-2 flex flex-col gap-1 z-20 shadow-xl">
              {wallets?.map((w) => (
                <button
                  key={w.id}
                  onClick={async () => {
                    await w.connect()
                    setShowWallets(false)
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-white/80 hover:bg-white/5 rounded-md transition-colors"
                >
                  {w.metadata.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={handleSwap}
          disabled={!canSwap}
          className="w-full rounded-lg bg-gradient-to-r from-magnet-600 to-magnet-500 py-3 text-sm font-semibold text-white shadow-md shadow-magnet-900/60 hover:from-magnet-500 hover:to-magnet-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150"
        >
          {swapping ? "Swapping…" : "Swap"}
        </button>
      )}

      <p className="text-xs text-gray-600 text-center">
        Best-price routing via Haystack
      </p>
    </div>
  )
}
