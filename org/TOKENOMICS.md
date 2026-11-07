# $U Tokenomics

## Token Details

| Field | Value |
|---|---|
| Name | Magnet |
| Ticker | $U |
| ASA ID | `3081853135` |
| Total Supply | 750,000 |
| Decimals | 5 (1 $U = 100,000 base units) |
| Network | Algorand mainnet |
| Standard | Algorand Standard Asset (ASA) |

---

## Roles

$U is the asset at the center of every Magnet Strategies product:

1. ~~**Governance token**~~ — **retired 2026-11-05.** Governance moved to mUSD
   (mVote); $U no longer carries a vote. See [vote/OVERVIEW.md](../vote/OVERVIEW.md).
   Weight is **1 $U = 1 vote** (proportional to the amount locked). See [vote/OVERVIEW.md](../vote/OVERVIEW.md).
2. **Vault collateral (MagnetFi)** — $U-based LP tokens (e.g. U/tALGO, U/USDC) are the
   collateral borrowers deposit to mint mUSD. See [magnetfi/v2/VAULT.md](../magnetfi/v2/VAULT.md).
3. **Liquidity anchor** — $U is the base asset in Magnet-paired DEX pools (Tinyman &
   Pact), surfaced under the **Liquidity Pools** pill of `/strategy`. (`/pools` folded into it and now
   redirects there.)
4. **Staking reward asset — third-party** — Myth Finance's **dualSTAKE** pays its
   Algorand consensus rewards in **$U** rather than ALGO, and a mint also *requires*
   $U at the current rate. So every magnetALGO holder is a structural buyer, on a
   contract that is not ours. Surfaced under the **Vaults** pill of `/strategy`; see
   [strategy/dualstake/OVERVIEW.md](../strategy/dualstake/OVERVIEW.md).

The token's utility grows in proportion to the depth and activity of the ecosystem it
anchors — more collateral, more liquidity, more governance participation.

**Note the asymmetry in (4).** It is the only demand source on this list that Magnet
neither operates nor can change: the reward asset, the fee rate and the contract are
Myth's, behind their admin keys and a one-week upgrade timelock. Good alignment, real
counterparty exposure, and the card says so in those words.

---

## Distribution

$U supply is not released all at once. Tokens are distributed progressively as new
liquidity pools and product activity form. This ties supply growth to real activity
rather than a fixed schedule, avoids large unlocks that create sudden sell pressure,
and aligns availability with the expansion of the protocol's market presence.

---

## Value Model

- **Liquidity fees** — swap fees from $U pools accrue to liquidity providers; as
  active pools and volume grow, the ecosystem's aggregate fee capacity expands.
- **Protocol usage** — vault borrowing (interest), PSM/mUSD activity, and treasury
  deployment all reinforce $U demand through utility rather than speculation.
- **External reward demand** — ALGO staked through dualSTAKE converts consensus
  rewards into $U buying, independent of Magnet's own activity.
- **Treasury** — protocol capital is deployed into $U-paired liquidity (see
  [TREASURY.md](./TREASURY.md)), building market depth around the token.
