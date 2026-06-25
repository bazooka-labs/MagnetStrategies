"use client";

import {
  WalletProvider as UseWalletProvider,
  useWallet as useUseWallet,
  WalletManager,
  WalletId,
  NetworkId,
  type Wallet,
} from "@txnlab/use-wallet-react";
import { type ReactNode, useMemo } from "react";

// Network is fixed at app startup. Defaults to mainnet (the live site); set
// NEXT_PUBLIC_ALGO_NETWORK=testnet to run the whole app against testnet for a
// deploy rehearsal (e.g. `NEXT_PUBLIC_ALGO_NETWORK=testnet npm run dev`).
export const MAGNET_NETWORK: "mainnet" | "testnet" =
  process.env.NEXT_PUBLIC_ALGO_NETWORK === "testnet" ? "testnet" : "mainnet";

const DEFAULT_NETWORK = MAGNET_NETWORK === "testnet" ? NetworkId.TESTNET : NetworkId.MAINNET;

export function WalletProvider({ children }: { children: ReactNode }) {
  const manager = useMemo(
    () =>
      new WalletManager({
        defaultNetwork: DEFAULT_NETWORK,
        options: { resetNetwork: true },
        networks: {
          [NetworkId.MAINNET]: {
            algod: {
              baseServer: "https://mainnet-api.algonode.cloud",
              port: "",
              token: "",
            },
          },
          [NetworkId.TESTNET]: {
            algod: {
              baseServer: "https://testnet-api.algonode.cloud",
              port: "",
              token: "",
            },
          },
        },
        wallets: [
          WalletId.PERA,
          WalletId.DEFLY,
          WalletId.LUTE,
          WalletId.KIBISIS,
          WalletId.EXODUS,
        ],
      }),
    []
  );

  return (
    <UseWalletProvider manager={manager}>
      {children}
    </UseWalletProvider>
  );
}

export function useWallet() {
  const {
    activeAccount,
    activeAddress,
    wallets,
    isReady,
    signTransactions,
    transactionSigner,
    algodClient,
  } = useUseWallet();

  const isConnecting = wallets?.some((w: Wallet) => w.isActive && !w.isConnected);

  return {
    address: activeAddress ?? null,
    activeAddress: activeAddress ?? null,
    isConnected: !!activeAccount,
    isConnecting: !!isConnecting,
    isReady,
    activeAccount,
    wallets,
    signTransactions,
    transactionSigner,
    algodClient,
    network: MAGNET_NETWORK,
    connect: async (walletId?: WalletId) => {
      const wallet = walletId
        ? wallets?.find((w: Wallet) => w.id === walletId)
        : wallets?.[0];
      if (wallet) {
        await wallet.connect();
      }
    },
    disconnect: async () => {
      const wallet = wallets?.find((w: Wallet) => w.isActive);
      if (wallet) {
        await wallet.disconnect();
      }
    },
  };
}
