# Magnet Strategies

Magnet Strategies is an Algorand-native DeFi organization founded in June 2025 with a
single long-term objective: to grow the value of the Magnet token ($U) at a rate that
consistently outpaces ALGO. The organization pursues yield across multiple Algorand
DeFi products — LP-collateral lending, a native stablecoin, strategic liquidity pools,
and partner money markets — and reinvests returns into the token's underlying value.

**A Bazooka Labs Product.**

## Live

- **Landing:** https://magnetstrategies.io
- **MagnetFi (the Bank):** https://magnetstrategies.io/magnetfi
- **mUSD:** https://magnetstrategies.io/musd
- **UVote (governance):** https://magnetstrategies.io/vote
- **Pools:** https://magnetstrategies.io/pools
- **$U token:** https://magnetstrategies.io/token

## Products

### MagnetFi
The lending/borrowing arm. **LP-collateral vaults + the mUSD stablecoin + Peg Stability
Module (PSMv3)** are **live on mainnet** — borrow mUSD against Tinyman LP tokens (U/tALGO,
U/USDC) while the LP keeps earning fees; mUSD is fully USDC-backed. Single-token
lend/borrow via partner **CompX** markets is also surfaced. mUSD ASA: `3615600399`.

→ [`magnetfi/v2/OVERVIEW.md`](./magnetfi/v2/OVERVIEW.md)

### UVote
The governance arm — **advisory, founder-led voting over $U**. The founder posts an
open question (liquidity, parameters, investments, or any direction); $U holders lock
tokens to signal a preference; the founder acts on the mandate. **Live on mainnet**
(App `3679681107`). Replaces the retired "MagnetDAO" quarterly-liquidity model.

→ [`magnetdao/UVOTE.md`](./magnetdao/UVOTE.md)

### Pools
$U liquidity pools across Tinyman & Pact with live fee/farm APRs and deep-links to add
liquidity (`/pools`).

## Token

| Field        | Value                         |
|--------------|-------------------------------|
| Name         | Magnet                        |
| Ticker       | $U                            |
| ASA ID       | 3081853135                    |
| Total Supply | 750,000 $U                    |
| Decimals     | 5 (1 $U = 100,000 base units) |
| Network      | Algorand mainnet              |
| Founded      | June 2025                     |

→ [`magnetdao/TOKENOMICS.md`](./magnetdao/TOKENOMICS.md)

## Repository Structure

```
MagnetStrategies/
├── README.md
├── magnetdao/          ← Org overview, $U tokenomics, treasury, UVote governance docs
│                          (UVOTE.md + UVOTE_SPEC.md)
├── magnetfi/           ← MagnetFi protocol docs
│   ├── v1/             ← Standard lending (code complete, superseded by v2)
│   └── v2/             ← LP vault + mUSD + PSMv3 — docs, contracts, oracle bot, tests (LIVE)
├── contracts/
│   └── magnetdao/uvote/ ← UVote voting contract (live on mainnet, App 3679681107)
└── web/                ← Next.js frontend (magnetstrategies.io)
```

> Note: the `magnetdao/` folder name is a legacy artifact of the original branding;
> its contents are the Magnet Strategies org + UVote governance docs.

## Built by Bazooka Labs

Magnet Strategies is developed and maintained by Bazooka Labs.
Follow: [X / Twitter](https://x.com/Bazooka_Labs) · [Discord](https://discord.gg/naqFXmfM)
