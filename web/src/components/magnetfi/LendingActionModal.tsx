"use client"

import { useState, useEffect } from "react"
import algosdk from "algosdk"
import { X, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react"
import { useWallet } from "@txnlab/use-wallet-react"
import {
  buildDepositTransactions,
  buildWithdrawTransactions,
  buildBorrowTransactions,
  buildRepayTransactions,
  type MarketData,
  type LendingTransactionBundle,
} from "@compx/sdk"

export type LendingAction = "supply" | "withdraw" | "borrow" | "repay"

interface Props {
  marketData: MarketData
  collateralMarket?: MarketData
  defaultAction?: LendingAction
  onClose: () => void
}

const ALGOD_URL = "https://mainnet-api.algonode.cloud"

const TABS: { id: LendingAction; label: string }[] = [
  { id: "supply", label: "Supply" },
  { id: "withdraw", label: "Withdraw" },
  { id: "borrow", label: "Borrow" },
  { id: "repay", label: "Repay" },
]

export function LendingActionModal({
  marketData,
  collateralMarket,
  defaultAction = "supply",
  onClose,
}: Props) {
  const { activeAddress, transactionSigner } = useWallet()
  const [action, setAction] = useState<LendingAction>(defaultAction)
  const [amount, setAmount] = useState("")
  const [collateralAmt, setCollateralAmt] = useState("")
  const [loading, setLoading] = useState(false)
  const [txId, setTxId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [balances, setBalances] = useState<Record<number, bigint>>({})

  const baseDec = marketData.baseTokenDecimals
  const lstDec = marketData.lstTokenDecimals
  const isU = marketData.baseTokenId === 3081853135
  const baseTicker = isU ? "$U" : "USDC"
  const collateralTicker = collateralMarket
    ? collateralMarket.baseTokenId === 3081853135 ? "c$U" : "cUSDC"
    : "LST"

  const baseBalance = balances[marketData.baseTokenId] ?? BigInt(0)
  const lstBalance = balances[marketData.lstTokenId] ?? BigInt(0)
  const collateralBalance = collateralMarket
    ? (balances[collateralMarket.lstTokenId] ?? BigInt(0))
    : BigInt(0)

  useEffect(() => {
    if (!activeAddress) return
    const algod = new algosdk.Algodv2("", ALGOD_URL, "")
    algod
      .accountInformation(activeAddress)
      .do()
      .then((info) => {
        const map: Record<number, bigint> = { 0: info.amount }
        for (const a of info.assets ?? []) {
          map[Number(a.assetId)] = a.amount
        }
        setBalances(map)
      })
      .catch(() => {})
  }, [activeAddress])

  function fmtBal(raw: bigint, dec: number): string {
    return (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 4 })
  }

  function rawMax(raw: bigint, dec: number): string {
    return String(Number(raw) / 10 ** dec)
  }

  function toMicro(val: string, dec: number): bigint {
    const n = parseFloat(val)
    if (!isFinite(n) || n <= 0) throw new Error("Enter a valid amount greater than 0")
    return BigInt(Math.round(n * 10 ** dec))
  }

  function resetForm() {
    setAmount("")
    setCollateralAmt("")
    setError(null)
    setTxId(null)
  }

  async function handleSubmit() {
    if (!activeAddress) { setError("Connect your wallet first"); return }
    setLoading(true)
    setError(null)
    setTxId(null)

    const algod = new algosdk.Algodv2("", ALGOD_URL, "")

    try {
      let bundle: LendingTransactionBundle

      if (action === "supply") {
        bundle = await buildDepositTransactions(algod, {
          appId: marketData.appId,
          sender: activeAddress,
          amount: toMicro(amount, baseDec),
        })
      } else if (action === "withdraw") {
        bundle = await buildWithdrawTransactions(algod, {
          appId: marketData.appId,
          sender: activeAddress,
          amount: toMicro(amount, lstDec),
        })
      } else if (action === "borrow") {
        if (!collateralMarket) throw new Error("No collateral market configured for this pool")
        bundle = await buildBorrowTransactions(algod, {
          appId: marketData.appId,
          sender: activeAddress,
          borrowAmount: toMicro(amount, baseDec),
          collateralAmount: toMicro(collateralAmt, collateralMarket.lstTokenDecimals),
          collateralTokenId: collateralMarket.lstTokenId,
        })
      } else {
        bundle = await buildRepayTransactions(algod, {
          appId: marketData.appId,
          sender: activeAddress,
          amount: toMicro(amount, baseDec),
        })
      }

      const signed = await transactionSigner(
        bundle.transactions,
        bundle.signers[0].transactionIndexes
      )
      await algod.sendRawTransaction(signed).do()
      const txid = bundle.transactions[0].txID()
      await algosdk.waitForConfirmation(algod, txid, 4)
      setTxId(txid)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Transaction failed")
    } finally {
      setLoading(false)
    }
  }

  const amountLabel =
    action === "withdraw"
      ? "LST receipt tokens to redeem"
      : `Amount (${baseTicker})`

  const canSubmit =
    !loading &&
    amount !== "" &&
    parseFloat(amount) > 0 &&
    (action !== "borrow" || (collateralAmt !== "" && parseFloat(collateralAmt) > 0))

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center p-4 pt-20"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0512]/97 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-gray-500">
              {isU ? "Magnet · $U" : "USDC"} Market
            </p>
            <h2 className="text-base font-semibold text-white mt-0.5">
              {marketData.supplyApy.toFixed(2)}% Supply · {marketData.borrowApy.toFixed(2)}% Borrow
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setAction(t.id); resetForm() }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                action === t.id
                  ? "text-white border-b-2 border-magnet-400"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Wallet balance */}
          {activeAddress && (
            <div className="rounded-xl bg-white/5 border border-white/5 px-4 py-3 text-xs space-y-1.5">
              {(action === "supply" || action === "repay") && (
                <div className="flex justify-between text-gray-400">
                  <span>Wallet {baseTicker}</span>
                  <span className="font-mono text-white">
                    {fmtBal(baseBalance, baseDec)} {baseTicker}
                  </span>
                </div>
              )}
              {action === "withdraw" && (
                <div className="flex justify-between text-gray-400">
                  <span>Your LST balance</span>
                  <span className="font-mono text-white">{fmtBal(lstBalance, lstDec)} LST</span>
                </div>
              )}
              {action === "borrow" && collateralMarket && (
                <div className="flex justify-between text-gray-400">
                  <span>Available collateral ({collateralTicker})</span>
                  <span className="font-mono text-white">
                    {fmtBal(collateralBalance, collateralMarket.lstTokenDecimals)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Primary amount input */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">{amountLabel}</label>
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-16 font-mono text-sm text-white placeholder-gray-700 focus:border-magnet-500/50 focus:outline-none"
              />
              {action === "supply" && (
                <button
                  onClick={() => setAmount(rawMax(baseBalance, baseDec))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-magnet-400 hover:text-magnet-300"
                >
                  MAX
                </button>
              )}
              {action === "withdraw" && (
                <button
                  onClick={() => setAmount(rawMax(lstBalance, lstDec))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-magnet-400 hover:text-magnet-300"
                >
                  MAX
                </button>
              )}
              {action === "repay" && (
                <button
                  onClick={() => setAmount(rawMax(baseBalance, baseDec))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-magnet-400 hover:text-magnet-300"
                >
                  MAX
                </button>
              )}
            </div>
          </div>

          {/* Collateral input — borrow only */}
          {action === "borrow" && collateralMarket && (
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">
                Collateral to lock ({collateralTicker})
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={collateralAmt}
                  onChange={(e) => setCollateralAmt(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 pr-16 font-mono text-sm text-white placeholder-gray-700 focus:border-magnet-500/50 focus:outline-none"
                />
                <button
                  onClick={() =>
                    setCollateralAmt(rawMax(collateralBalance, collateralMarket.lstTokenDecimals))
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-magnet-400 hover:text-magnet-300"
                >
                  MAX
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-600">
                Max LTV {(marketData.ltv / 100).toFixed(0)}% · Liquidation at{" "}
                {(marketData.liquidationThreshold / 100).toFixed(0)}%
              </p>
            </div>
          )}

          {/* Withdraw hint */}
          {action === "withdraw" && (
            <p className="text-xs text-gray-600">
              Enter the amount of LST receipt tokens to return. You&apos;ll receive the
              underlying {baseTicker} back from the pool.
            </p>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {/* Success */}
          {txId && (
            <div className="flex items-start gap-2 rounded-xl border border-green-500/20 bg-green-500/10 px-4 py-3 text-xs text-green-400">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Transaction confirmed</p>
                <a
                  href={`https://allo.info/tx/${txId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-1 underline hover:text-green-300"
                >
                  View on Allo <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {/* CTA */}
          {!activeAddress ? (
            <p className="rounded-xl border border-white/10 bg-white/5 py-3.5 text-center text-sm text-gray-500">
              Connect your wallet to interact
            </p>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full rounded-xl bg-magnet-600 py-3.5 text-sm font-semibold text-white hover:bg-magnet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading
                ? "Confirming…"
                : action === "supply"
                ? `Supply ${baseTicker}`
                : action === "withdraw"
                ? `Withdraw ${baseTicker}`
                : action === "borrow"
                ? `Borrow ${baseTicker}`
                : `Repay ${baseTicker}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
