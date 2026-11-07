# Magnet Strategies — Overview

Magnet Strategies is an Algorand-native DeFi organization founded in June 2025, built
on years of hands-on Algorand DeFi experience. Its objective is to grow the value of
the Magnet token ($U) at a rate that outpaces simply holding ALGO — through a suite of
DeFi products and diversified yield strategies rather than a single bet.

**A Bazooka Labs product.** Site: [magnetstrategies.io](https://magnetstrategies.io)

---

## The Magnet Token ($U)

| Field | Value |
|---|---|
| Name | Magnet |
| Ticker | $U |
| ASA ID (mainnet) | `3081853135` |
| Total Supply | 750,000 $U |
| Decimals | 5 (1 $U = 100,000 base units) |
| Network | Algorand mainnet |
| Founded | June 2025 |

$U is the asset at the center of every Magnet Strategies product — collateral for
MagnetFi LP-vault loans, the anchor asset in Magnet liquidity pairs, and the
collateral and LP anchor. Governance moved to mUSD on 2026-11-05 and $U no
longer carries a vote. See [TOKENOMICS.md](./TOKENOMICS.md).

---

## Products

| Product | What it is | Route | Docs |
|---|---|---|---|
| **MagnetFi** (the Bank) | LP-collateral vaults + the **mUSD** stablecoin + Peg Stability Module (PSMv3). Borrow mUSD against Tinyman LP tokens while the LP keeps earning fees. **Live on mainnet.** | `/magnetfi` | [magnetfi/v2/OVERVIEW.md](../magnetfi/v2/OVERVIEW.md) |
| **Single-Token Markets** | Lend/borrow individual assets via partner **CompX**'s money markets (surfaced read-only + deep-link). | `/magnetfi` → Markets | — |
| **Trading Terminal** | Leveraged perpetuals on **PEX**, Ultrade's Algorand perps protocol. Magnet writes no contract; every action is a PEX call signed by the user and asserted by us first. **Live on mainnet.** | `/trade` | [strategy/perps/OVERVIEW.md](../strategy/perps/OVERVIEW.md) |
| **Strategy Pools** | Liquidity into PEX's perp pools and its managed **C-Vault** — you earn fees and take the other side of the book. Deposits and withdrawals are signed in our own UI. **Live on mainnet**; only the C-Vault is public, the two direct market pools are admin-gated. | `/strategy` → Vaults | [strategy/pools/OVERVIEW.md](../strategy/pools/OVERVIEW.md) |
| **magnetALGO** | Liquid staking on **Myth Finance's** dualSTAKE: deposit ALGO, hold magnetALGO, and consensus rewards accrue in **$U** rather than ALGO — making every holder a structural $U buyer. Third-party contract, upgradeable behind a one-week timelock. **Live on mainnet 2026-11-07.** | `/strategy` → Vaults | [strategy/dualstake/OVERVIEW.md](../strategy/dualstake/OVERVIEW.md) |
| **mVote** | Advisory, founder-led governance. Holders lock whole **mUSD** to signal on protocol direction, one mUSD to one vote. **Live on mainnet** (App `3763268387`). Replaces UVote, which voted with $U and is retired (App `3679681107`, readable for history only). | `/tokens#governance` | [vote/OVERVIEW.md](../vote/OVERVIEW.md) |
| **mUSD page** | Nav label **mUSD**. Two pills: Exchange (peg, backing, holders, chart, PSM swap) and Governance (mVote). The swap reuses MagnetFi's PSM mint/redeem rather than reimplementing it. Absorbed `/musd` and `/about`. | `/tokens` | [mUSD.md](../magnetfi/v2/mUSD.md) |
| **Magnet Token** | $U as a strategy in its own right — the original one: price, holders, TVL, **ASA TVL Rank**, chart and swap, under the **Magnet Token** pill on the Strategy page, beside the $U liquidity pools. Absorbed `/token`, `/pools` and `/earn`. | `/strategy` | [TOKENOMICS.md](./TOKENOMICS.md) |
| **ASA TVL Tracker** | Cross-DEX liquidity analytics: the top 100 Algorand ASAs by TVL. Surfaced as the **TVL Rank** box on the Magnet Token pill of `/strategy` (with a Top 100 modal) and a public read API. Reads Pact's managed-weighted pools that Vestige and other indexers miss. **Live.** | `/strategy`, `/api/leaderboard` | [ASA_TVL_SPEC.md](../ASA_TVL_SPEC.md) |
| **Contact** | On-chain support inbox + broadcast channel (no backend — wallet-signed note-field messages). | `/contact` | — |

---

## Treasury

The treasury is funded by revenue from Bazooka Labs' applications and deployed into
Algorand DeFi — primarily $U-paired liquidity. It is not a $U accumulator; it acts as
a deployment engine that pairs treasury capital with $U to build market depth. Its
live USDC balance is shown as the Treasury box on both token views — the Magnet
Token pill of `/strategy` and the Exchange pill of `/tokens`. Governance
proposals often direct where
that capital is pointed. See [TREASURY.md](./TREASURY.md).

---

## Governance

Governance runs through **mVote** — advisory, founder-led voting where mUSD holders lock
tokens to signal on an open question (liquidity, parameters, investments, or any
direction the founder puts forward). It is not a decentralized DAO: the founder retains
execution authority; mVote produces a clear on-chain mandate. Full model, voter
guarantees, and lifecycle in [vote/OVERVIEW.md](../vote/OVERVIEW.md); contract + audit
detail in [vote/SPEC.md](../vote/SPEC.md).

> **History note.** mVote replaced UVote on 2026-11-05, changing the voting asset from
> $U to mUSD — a new contract, because the asset id is fixed at creation by design.
> UVote itself replaced the original "MagnetDAO" framing — a quarterly cycle
> for outside projects to apply for treasury liquidity — which was too narrow for what
> holder governance can shape. The old model, its application portal, and the original
> voting app (`3554779766`) are retired.

---

## Open items

**Decide the fate of the legacy MagnetDAO contracts.** `contracts/legacy/`
holds `governance.py`, `treasury.py` and `voting.py` from the retired
quarterly-liquidity model. They were separated from the UVote contract on
2026-10-27, which makes the question easier to answer but does not answer it. `voting.py` was deployed as App `3554779766` and is
dormant: it holds **zero $U**, so no user funds are in it, and
`VOTING_APP_ID` in `web/src/lib/constants.ts` is defined but never imported
anywhere — verified 2026-10-27. Archive or delete.

The current governance contract lives at `contracts/mvote/`, with the retired
UVote kept beside it at `contracts/uvote/`. See the note in
the root [README](../README.md).

Per-product open items live with their product: [MagnetFi](../magnetfi/v2/OVERVIEW.md),
[Trading Terminal](../strategy/perps/OVERVIEW.md),
[Strategy Pools](../strategy/pools/OVERVIEW.md),
[magnetALGO](../strategy/dualstake/OVERVIEW.md), [ASA TVL](../ASA_TVL_SPEC.md).

---

## Web App

Next.js frontend at [magnetstrategies.io](https://magnetstrategies.io); routes above.
Architecture and per-route detail: [web/README.md](../web/README.md).

---

## Social

- **X / Twitter:** https://x.com/Bazooka_Labs
- **Discord:** https://discord.gg/naqFXmfM
