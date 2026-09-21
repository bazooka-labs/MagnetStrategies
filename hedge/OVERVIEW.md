# Hedge

Hedge is the price-markets arm of Magnet Strategies: a daily intraday ladder on BTC, settled against a future price and denominated entirely in **mUSD**.

Hedge is admin-managed. The protocol admin creates rounds, sets rake, and operates the keeper that posts settlement prices. There is no governance token. Trust is placed in Bazooka Labs as operator, and mitigated by open-sourcing every contract (see [Open Source Policy](#open-source-policy)).

**Status:** Design stage. One product scoped — VPL. Nothing is built or deployed.

---

## Why mUSD Is the Base Currency

Hedge exists to give mUSD holders reasons to keep mUSD in their wallets rather than redeeming it for USDC.

This is a claim about **holding behaviour, not price.** mUSD is a stablecoin — if it works, it is worth $1 forever, and no amount of product volume changes that. What Hedge moves is narrower and more honest:

| Lever | Mechanism |
|---|---|
| **Float** | mUSD sits in escrow for the life of a round and cannot be redeemed while it is there. Longer round windows produce more dwell time; very short windows produce almost none. |
| **Denomination lock-in** | Payouts are made in mUSD, not USDC. A winner receives mUSD and faces the exit decision again rather than having exited automatically. Each round, some fraction stays. |
| **Entry demand** | Playing requires mUSD. Players arriving with USDC mint through the PSM (free, 1:1) to participate. |

What Hedge does **not** do is increase mUSD's backing. Rake routes to the Magnet Strategies treasury, not to PSM reserves — a deliberate choice trading direct backing accrual for treasury flexibility. The treasury may route funds to the PSM at its discretion; the contract has no opinion on it.

Supporting context: the PSM already charges 1% on mUSD→USDC redemption and 0% on mint. Entry into mUSD is friction-free; exit is not. Hedge adds reasons to stay on the near side of that asymmetry.

### Metrics That Matter

Instrument these from the first deployment. They are the only honest measure of whether the sector works:

- **% of minted mUSD that never touches PSM redeem**
- **Median mUSD holding duration**
- **mUSD locked in Hedge escrow** (absolute, and as % of circulating mUSD)

Volume and rake revenue are business metrics. They are not evidence the sector achieved its purpose.

---

## Architecture

Hedge is a single self-contained contract. No framework, no game core, no adapter interface.

```
Magnet Strategies
├── UVote          ← advisory governance over $U
├── MagnetFi       ← lending & borrowing (mUSD issuer)
└── Hedge          ← daily BTC ladder (mUSD consumer)
    ├── hedge-oracle   ← price feed, ring-fenced from MagnetFi
    └── ladder         ← the contract
```

### Build Standalone, Extract Later

Hedge is **one product**, and the right structure for one product is one self-contained contract. No shared module, no adapter interface, no abstraction built for a second thing that does not exist. If a second product ever ships, shared pieces get extracted then — against two real implementations rather than one real and one hypothetical.

Three commitments hold regardless of what follows:

**A Hedge oracle app, separate from the MagnetFi vault oracle.**

> **Hedge must never read the oracle that MagnetFi liquidations depend on.**

If it shared the vault price feed, manipulating a payout and manipulating protocol solvency would become the same action. Separate app, separate feed, no exceptions.

**A treasury address, not a router.** Rake sends to an address. Because the contract targets an address rather than a hardcoded split, a splitter routing to treasury, PSM reserves, or $U buyback can be introduced later without touching or redeploying it.

**The existing frontend.** Hedge lives inside the Magnet Strategies app and uses the existing connect-wallet flow. No separate wallet architecture, no custody, no session keys, no server-side signing. Every user action is a wallet-signed transaction.

### Parameters

Rake rate, basis, payout rules, stake models, and entry weighting all live on the contract as configuration rather than convention. `rake_bps` carries a hard cap that cannot itself be raised.

### Deliverables

| Component | Convention |
|---|---|
| Contract | `contracts/hedge/ladder/` |
| Reads | `web/src/lib/hedge/ladderReads.ts` (algosdk) |
| Writes | `web/src/lib/hedge/ladderClient.ts` (algokit-utils, lazy-loaded) |
| Route | `web/src/app/hedge/` |
| Admin | Tab in the Hedge admin panel, gated to admin address |
| Ops | Keeper cron for round resolution |

Mirrors the existing `magnetfiReads` / `magnetfiClient` / `magnetfiOps` split.

---

## Ring-Fencing From MagnetFi

Hedge consumes mUSD. It is never part of mUSD's issuance or solvency machinery.

- Hedge contracts hold mUSD as **ordinary balance only**. They never mint, never burn, and hold no protocol role
- Hedge never reads or writes MagnetFi state
- Hedge uses its own oracle app
- Rake flows one way: Hedge → treasury. Nothing flows back

MagnetFi's core invariant — *circulating mUSD ≤ PSM USDC reserves* — is unaffected. mUSD held in Hedge escrow is circulating mUSD like any other; escrowing it neither mints nor destroys it, so the invariant is untouched in both directions.

---

## Open Source Policy

**The Hedge contract and its frontend are public**, in the same repo and under the same terms as the rest of Magnet Strategies.

The reasoning is not ideological:

1. **The contract is public regardless.** Approval programs are readable on-chain, and any published client library carries the full ABI with it. Closed-sourcing an Algorand contract obscures nothing of substance — it converts a one-hour read into a one-day read. A deployed contract's mechanism, admin powers, and fee take can be reconstructed from chain data alone, and deleting a repo does not undo that.
2. **Trust is the binding constraint.** Hedge's admin sets the rake, creates rounds, and operates the keeper that posts the settlement price deciding who wins. From a user's seat, a closed-source contract with an operator-supplied resolving price is indistinguishable from a rigged one. Open source converts *trust the operator* into *verify the contract, then trust only the price feed.*
3. **Consistency.** MagnetFi is public and it custodies real collateral and can liquidate people. A closed price market alongside an open lending protocol reads as concealment.

**Carve-out — off-chain operations may stay private.** The keeper's scheduling, price-source aggregation, outlier handling, redundancy, and failover are a separate service and are not part of any game's public repo. That is where operational edge legitimately lives.

---

## Documents

| | |
|---|---|
| [ORACLE.md](./ORACLE.md) | Price service — sources, attestation format, trust model |
| [perps/OVERVIEW.md](./perps/OVERVIEW.md) | Perps — PEX integration: platform facts, verified constants, integration paths considered |
| [../predict/OVERVIEW.md](../predict/OVERVIEW.md) | **Predict** — the ladder product line, moved to its own tree |

**VPL moved to [`predict/`](../predict/).** It shipped first and lives under the
`/predict` route, so it has its own self-contained tree — docs, contract, keeper. The
sector framing above is duplicated there rather than cross-linked, so neither tree
depends on the other. Hedge keeps this overview and `ORACLE.md` for the perps work.
