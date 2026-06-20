"use client"

import { useState, useEffect, useRef } from "react"
import { RouterClient } from "@txnlab/haystack-router"
import type { SwapQuote } from "@txnlab/haystack-router"
import { useWallet } from "@/hooks/useWallet"
import { toast } from "sonner"

const ALGO_ID = 0
const MAGNET_ID = 3081853135
const MAGNET_FACTOR = 100_000
const HAYSTACK_KEY = "1b72df7e-1131-4449-8ce1-29b79dd3f51e"

const router = new RouterClient({ apiKey: HAYSTACK_KEY, autoOptIn: true })

export function HaystackSwap() {
  const { isConnected, activeAddress, transactionSigner, wallets } = useWallet()

  const [algoIn, setAlgoIn] = useState("")
  const [previewOut, setPreviewOut] = useState<number | null>(null)
  const [priceImpact, setPriceImpact] = useState<number | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [showWallets, setShowWallets] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestQuoteRef = useRef<SwapQuote | null>(null)

  useEffect(() => {
    const microAlgo = Math.round(parseFloat(algoIn) * 1_000_000)
    if (!algoIn || isNaN(microAlgo) || microAlgo <= 0) {
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
          fromASAID: ALGO_ID,
          toASAID: MAGNET_ID,
          amount: microAlgo,
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
  }, [algoIn, activeAddress])

  async function handleSwap() {
    if (!isConnected || !activeAddress || !transactionSigner) return
    const microAlgo = Math.round(parseFloat(algoIn) * 1_000_000)
    if (!algoIn || isNaN(microAlgo) || microAlgo <= 0) return

    setSwapping(true)
    try {
      const q = await router.newQuote({
        fromASAID: ALGO_ID,
        toASAID: MAGNET_ID,
        amount: microAlgo,
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
      setAlgoIn("")
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
    <div className="relative rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm p-5 flex flex-col gap-4 shadow-xl shadow-black/50">
      <div className="absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-left">Swap</p>

      {/* ALGO input */}
      <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 flex items-center gap-3">
        <span className="text-sm font-semibold text-gray-400 w-12 shrink-0">ALGO</span>
        <input
          type="number"
          min="0"
          placeholder="0.00"
          value={algoIn}
          onChange={(e) => setAlgoIn(e.target.value)}
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
