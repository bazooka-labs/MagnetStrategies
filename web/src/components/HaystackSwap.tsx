"use client"

import { useState, useEffect, useRef } from "react"
import { RouterClient } from "@txnlab/haystack-router"
import type { SwapQuote } from "@txnlab/haystack-router"
import { useWallet } from "@/hooks/useWallet"
import { toast } from "sonner"

const USDC_ID = 31566704
const MAGNET_ID = 3081853135
const MAGNET_FACTOR = 100_000
const USDC_FACTOR = 1_000_000
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

  const [usdcIn, setUsdcIn] = useState("")
  const [previewOut, setPreviewOut] = useState<number | null>(null)
  const [priceImpact, setPriceImpact] = useState<number | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [showWallets, setShowWallets] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestQuoteRef = useRef<SwapQuote | null>(null)

  useEffect(() => {
    const microUsdc = Math.round(parseFloat(usdcIn) * USDC_FACTOR)
    if (!usdcIn || isNaN(microUsdc) || microUsdc <= 0) {
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
          fromASAID: USDC_ID,
          toASAID: MAGNET_ID,
          amount: microUsdc,
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
  }, [usdcIn, activeAddress])

  async function handleSwap() {
    if (!isConnected || !activeAddress || !transactionSigner) return
    const microUsdc = Math.round(parseFloat(usdcIn) * USDC_FACTOR)
    if (!usdcIn || isNaN(microUsdc) || microUsdc <= 0) return

    setSwapping(true)
    try {
      const q = await router.newQuote({
        fromASAID: USDC_ID,
        toASAID: MAGNET_ID,
        amount: microUsdc,
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
      setUsdcIn("")
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

      {/* USDC input */}
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 flex items-center gap-3">
        <span className="text-sm font-semibold text-gray-400 w-12 shrink-0">USDC</span>
        <input
          type="number"
          min="0"
          placeholder="0.00"
          value={usdcIn}
          onChange={(e) => setUsdcIn(e.target.value)}
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
