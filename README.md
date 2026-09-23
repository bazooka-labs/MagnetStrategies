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

### Strategy
The DeFi strategy arm — products where a user **takes a position or deploys capital into
an engineered strategy**, as opposed to accepting a posted rate (that is the Bank). Some
run on our contracts, some on a third party's. First product is **Perps**: leveraged
positions on **PEX**, Ultrade's Algorand perpetuals protocol, where Magnet writes no
contract and every action is a PEX call signed by the user's wallet. Strategy vaults and
advanced trading surfaces come later.

→ [`strategy/OVERVIEW.md`](./strategy/OVERVIEW.md)

### Predict
**VPL — Volatility Prediction Ladder.** mUSD-denominated, user-to-user price markets:
the protocol never takes the other side, holds no inventory, and carries no directional
risk. Its own tree and its own page, deliberately — those guarantees are Predict's
identity and must not be imported into products that do not offer them.

→ [`predict/OVERVIEW.md`](./predict/OVERVIEW.md)

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
├── magnetfi/           ← MagnetFi protocol docs — the "Bank"
│   └── v2/             ← LP vault + mUSD + PSMv3 — docs, contracts, oracle bot, tests (LIVE)
├── strategy/           ← The "Strategy" arm
│   ├── OVERVIEW.md     ← Admission criterion + arm-wide commitments
│   ├── ORACLE.md       ← Arm-level price doctrine
│   └── perps/          ← Perps on PEX — OVERVIEW, SPEC, PEX platform reference
├── predict/            ← VPL volatility ladder — docs, contracts, keeper
├── contracts/
│   ├── magnetdao/uvote/ ← UVote voting contract (live on mainnet, App 3679681107)
│   └── lending/         ← v1 oracle + pool (compiled, superseded by magnetfi v2)
└── web/                ← Next.js frontend (magnetstrategies.io)
```

### Nav, and where its docs live

The app nav is organised by **user intent**; the repo is organised by **where doctrine
lives**. They are allowed to differ, and a tree exists only where there is shared
doctrine to hold.

| Nav | Docs | Note |
|---|---|---|
| Tokens | `magnetfi/` (mUSD) + `magnetdao/` (\$U) | A page, not a tree — it composes two products |
| Bank | `magnetfi/` | One product; "Bank" is the label, MagnetFi is the name |
| Strategy | `strategy/` | A real tree: multiple products sharing price doctrine and commitments |
| Predict | `predict/` | Stands alone by design |
| Vote | `magnetdao/` | UVote governance docs |
| Contact | — | Frontend only |

> Note: the `magnetdao/` folder name is a legacy artifact of the original branding;
> its contents are the Magnet Strategies org + UVote governance docs.

## Built by Bazooka Labs

Magnet Strategies is developed and maintained by Bazooka Labs.
Follow: [X / Twitter](https://x.com/Bazooka_Labs) · [Discord](https://discord.gg/naqFXmfM)
