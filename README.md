# Magnet Strategies

Magnet Strategies is an Algorand-native DeFi organization founded in June 2025 with a
single long-term objective: to grow the value of the Magnet token ($U) at a rate that
consistently outpaces ALGO. The organization pursues yield across multiple Algorand
DeFi products — LP-collateral lending, a native stablecoin, strategic liquidity pools,
and partner money markets — and reinvests returns into the token's underlying value.

**A Bazooka Labs Product.**

## Live

- **Landing:** https://magnetstrategies.io
- **Tokens ($U + mUSD):** https://magnetstrategies.io/tokens
- **Bank (MagnetFi):** https://magnetstrategies.io/magnetfi
- **Predict:** https://magnetstrategies.io/predict
- **Vote (UVote):** https://magnetstrategies.io/vote
- **Contact:** https://magnetstrategies.io/contact

> `/token`, `/musd` and `/pools` were retired — all three are now tabs and sections
> inside `/tokens`. `/about` became a modal on the same page.

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

→ [`vote/UVOTE.md`](./vote/UVOTE.md)

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

### Tokens
The **$U token** and **mUSD** on one page (`/tokens`), with live stats, charts, swap, and
the $U liquidity pools across Tinyman & Pact (fee/farm APRs, deep-links to add liquidity).
Absorbed the former `/token`, `/musd`, `/pools` and `/about` pages.

→ [`org/TOKENOMICS.md`](./org/TOKENOMICS.md) ($U) · [`magnetfi/v2/mUSD.md`](./magnetfi/v2/mUSD.md) (mUSD)

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

→ [`org/TOKENOMICS.md`](./org/TOKENOMICS.md)

## Repository Structure

```
MagnetStrategies/
├── README.md
├── org/                ← Org overview, $U tokenomics, treasury, roadmap
├── vote/               ← UVote governance — UVOTE.md + UVOTE_SPEC.md
├── magnetfi/           ← MagnetFi protocol docs — the "Bank"
│   └── v2/             ← LP vault + mUSD + PSMv3 — docs, contracts, oracle bot, tests (LIVE)
├── strategy/           ← The "Strategy" arm
│   ├── OVERVIEW.md     ← Admission criterion + arm-wide commitments
│   ├── ORACLE.md       ← Arm-level price doctrine
│   └── perps/          ← Perps on PEX — OVERVIEW, SPEC, PEX platform reference
├── predict/            ← VPL volatility ladder — docs, contracts, keeper
├── contracts/
│   └── magnetdao/       ← MagnetDAO-era contracts. `uvote/` is the live one
│                          (App 3679681107); governance/treasury/voting are retired
└── web/                ← Next.js frontend (magnetstrategies.io)
```

### Nav, and where its docs live

The app nav is organised by **user intent**; the repo is organised by **where doctrine
lives**. They are allowed to differ, and a tree exists only where there is shared
doctrine to hold.

| Nav | Docs | Note |
|---|---|---|
| Tokens | `org/` (\$U) + `magnetfi/v2/mUSD.md` | A page, not a tree — it composes two products |
| Bank | `magnetfi/` | One product; "Bank" is the label, MagnetFi is the name |
| Strategy | `strategy/` | A real tree: multiple products sharing price doctrine and commitments |
| Predict | `predict/` | Stands alone by design |
| Vote | `vote/` | UVote — its own live contract and spec |
| Contact | — | Frontend only |

> Note: **MagnetDAO** was the first governance vision, later rebuilt as **UVote**. The
> docs tree is split into `org/` and `vote/` accordingly.
>
> `contracts/magnetdao/` deliberately keeps the old name, and the name is accurate —
> it holds the MagnetDAO-era contracts, of which only `uvote/` survived. Renaming was
> considered and rejected: `deploy_uvote.py` does `from uvote.uvote import ...`, a real
> package import, so moving the directory breaks the deploy script for a live
> governance contract, and breaks it silently — the failure would surface at the next
> redeploy, which is exactly when surprises are least welcome. Cosmetic gain, real risk.
>
> The retired `governance.py` / `treasury.py` / `voting.py` still sit there. `voting.py`
> was deployed (App `3554779766`) and is dormant: it holds **zero $U**, so no user funds
> are in it, and `VOTING_APP_ID` in `web/src/lib/constants.ts` is defined but never read.
> Their fate is an open item in [`org/TODO.md`](./org/TODO.md).

## Other Documents

| | |
|---|---|
| [`org/OVERVIEW.md`](./org/OVERVIEW.md) | The organization — objective, product suite, history |
| [`org/TREASURY.md`](./org/TREASURY.md) | Treasury funding sources and policy |
| [`org/TODO.md`](./org/TODO.md) | Org-level roadmap *(last reviewed 2026-06)* |
| [`CONTACT.md`](./CONTACT.md) | On-chain messaging between users and the admin — the `/contact` surface |
| [`SECURITY.md`](./SECURITY.md) | Security policy and disclosure |

## Built by Bazooka Labs

Magnet Strategies is developed and maintained by Bazooka Labs.
Follow: [X / Twitter](https://x.com/Bazooka_Labs) · [Discord](https://discord.gg/naqFXmfM)
