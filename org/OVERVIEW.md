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
governance token for UVote. See [TOKENOMICS.md](./TOKENOMICS.md).

---

## Products

| Product | What it is | Route | Docs |
|---|---|---|---|
| **MagnetFi** (the Bank) | LP-collateral vaults + the **mUSD** stablecoin + Peg Stability Module (PSMv3). Borrow mUSD against Tinyman LP tokens while the LP keeps earning fees. **Live on mainnet.** | `/magnetfi` | [magnetfi/v2/OVERVIEW.md](../magnetfi/v2/OVERVIEW.md) |
| **Single-Token Markets** | Lend/borrow individual assets via partner **CompX**'s money markets (surfaced read-only + deep-link). | `/magnetfi` → Markets | — |
| **UVote** | Advisory, founder-led governance over $U. Holders lock $U to signal on protocol direction. **Live on mainnet** (App `3679681107`). | `/tokens#governance` | [vote/OVERVIEW.md](../vote/OVERVIEW.md) |
| **Tokens** | **$U** and **mUSD** on one page: price, holders, TVL, **ASA TVL Rank**, chart, swap, and the $U liquidity pools across Tinyman & Pact. The mUSD swap reuses MagnetFi's PSM mint/redeem rather than reimplementing it. Absorbed the former `/token`, `/musd`, `/pools` and `/about`. | `/tokens` | [TOKENOMICS.md](./TOKENOMICS.md) · [mUSD.md](../magnetfi/v2/mUSD.md) |
| **ASA TVL Tracker** | Cross-DEX liquidity analytics: the top 100 Algorand ASAs by TVL. Surfaced as the **TVL Rank** box on `/tokens` (with a Top 100 modal) and a public read API. Reads Pact's managed-weighted pools that Vestige and other indexers miss. **Live.** | `/tokens`, `/api/leaderboard` | [ASA_TVL_SPEC.md](../ASA_TVL_SPEC.md) |
| **Contact** | On-chain support inbox + broadcast channel (no backend — wallet-signed note-field messages). | `/contact` | — |

---

## Treasury

The treasury is funded by revenue from Bazooka Labs' applications and deployed into
Algorand DeFi — primarily $U-paired liquidity. It is not a $U accumulator; it acts as
a deployment engine that pairs treasury capital with $U to build market depth. Its
live USDC balance is shown in the Governance section of `/tokens`. UVote
proposals often direct where
that capital is pointed. See [TREASURY.md](./TREASURY.md).

---

## Governance

Governance runs through **UVote** — advisory, founder-led voting where $U holders lock
tokens to signal on an open question (liquidity, parameters, investments, or any
direction the founder puts forward). It is not a decentralized DAO: the founder retains
execution authority; UVote produces a clear on-chain mandate. Full model, voter
guarantees, and lifecycle in [vote/OVERVIEW.md](../vote/OVERVIEW.md); contract + audit
detail in [vote/SPEC.md](../vote/SPEC.md).

> **History note.** UVote replaced the original "MagnetDAO" framing — a quarterly cycle
> for outside projects to apply for treasury liquidity — which was too narrow for what
> holder governance can shape. The old model, its application portal, and the original
> voting app (`3554779766`) are retired.

---

## Open items

**Decide the fate of the legacy MagnetDAO contracts.** `contracts/magnetdao/`
holds `governance.py`, `treasury.py` and `voting.py` from the retired
quarterly-liquidity model. `voting.py` was deployed as App `3554779766` and is
dormant: it holds **zero $U**, so no user funds are in it, and
`VOTING_APP_ID` in `web/src/lib/constants.ts` is defined but never imported
anywhere — verified 2026-10-27. Archive or delete.

The directory keeps its old name deliberately; `deploy_uvote.py` imports from
it as a real package, so renaming breaks the deploy of the **live** governance
contract silently. See the note in the root [README](../README.md).

Per-product open items live with their product: [MagnetFi](../magnetfi/v2/OVERVIEW.md),
[Strategy Pools](../strategy/pools/OVERVIEW.md), [ASA TVL](../ASA_TVL_SPEC.md).

---

## Web App

Next.js frontend at [magnetstrategies.io](https://magnetstrategies.io); routes above.
Architecture and per-route detail: [web/README.md](../web/README.md).

---

## Social

- **X / Twitter:** https://x.com/Bazooka_Labs
- **Discord:** https://discord.gg/naqFXmfM
