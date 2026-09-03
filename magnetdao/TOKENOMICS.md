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

1. **Governance token (UVote)** — holders lock $U to vote on protocol direction.
   Weight is **1 $U = 1 vote** (proportional to the amount locked). See [UVOTE.md](./UVOTE.md).
2. **Vault collateral (MagnetFi)** — $U-based LP tokens (e.g. U/tALGO, U/USDC) are the
   collateral borrowers deposit to mint mUSD. See [magnetfi/v2/VAULT.md](../magnetfi/v2/VAULT.md).
3. **Liquidity anchor** — $U is the base asset in Magnet-paired DEX pools (Tinyman &
   Pact), surfaced on the `/pools` page.

The token's utility grows in proportion to the depth and activity of the ecosystem it
anchors — more collateral, more liquidity, more governance participation.

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
- **Treasury** — protocol capital is deployed into $U-paired liquidity (see
  [TREASURY.md](./TREASURY.md)), building market depth around the token.
