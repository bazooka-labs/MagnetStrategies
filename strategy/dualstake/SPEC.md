# magnetALGO dualSTAKE — Build Spec

_Status: **spec only, nothing built.** Written 2026-11-06 against Myth's own
documentation and SDK, after an earlier reverse-engineered draft got the mint
shape wrong. See OVERVIEW.md for that history — it is the reason this file
exists before any code._

## 1. The recipe is Myth's, not ours

| | |
|---|---|
| SDK | `@myth-finance/dualstake-ts-sdk` **3.3.10** |
| Docs | `docs.myth.finance/dualSTAKE` — `mint`, `redeem`, `rate`, `abi`, `ts-sdk`, `immutability` |
| Peer deps | `algosdk >= 3.4.0`, `@algorandfoundation/algokit-utils ^9.0.0`, `js-sha512 ^0.9.0` |
| Deps | `buffer`, `p-map` |

**Licence discrepancy to resolve before shipping.** `package.json` declares
`"license": "BSL"` while the shipped `LICENSE` file is plain **MIT**. MIT is
permissive and fine for this repo, but the two disagree and the repo is
public. Ask Myth which governs before taking the dependency.

### The SDK surface we need

```ts
class DualStakeClient {
  getRate(): Promise<bigint>
  getState(): Promise<DSContractState>     // rate, asaBalance, staked, ratePrecision
  getListing(): Promise<DSContractListing>
  makeMintTransactions({ algoAmount: number }): Promise<DualStakeContractComposer>
  makeRedeemTransactions({ dsAmount: number }): Promise<DualStakeContractComposer>
}
```

**Use `makeMintTransactions` / `makeRedeemTransactions`, never `mint()` /
`redeem()`.** The latter build *and send*. We need the composer so the group
can be (a) asserted by us and (b) signed by the user's wallet through
`use-wallet`, which is how every other signing path in this app works.

**The SDK computes the $U leg.** Minting is "X ALGO + Y ASA" where Y comes
from the current mint exchange rate, and getting Y wrong is exactly the error
the reverse-engineered draft made. `makeMintTransactions` takes only
`algoAmount` and derives Y itself. We must not re-derive it.

## 2. What we build

```
web/src/lib/strategy/dualstake/
  config.ts    pinned app id 3760408044, LST 3760411000, $U 3081853135,
               pinned program hash, cap, fee bps
  reads.ts     rate, staked, asaBalance, cap headroom, the user's holding
  client.ts    mint/redeem via the SDK composer + our assertion, then sign
  group.ts     the pre-sign assertion (see §3)
web/src/components/strategy/dualstake/
  DualStakeCard.tsx      the card
  DualStakeActions.tsx   deposit / redeem form
```

## 3. The assertion layer — non-negotiable

The SDK is Myth's code building a group that moves our user's funds. We assert
it ourselves before signing, exactly as `pex/group.ts` does, because a
dependency compromise or an SDK bug must not be able to produce a signature.

Asserted before any wallet prompt:

- **Shape**: transaction count and types within a pinned envelope.
- **Pinned app id** — only `3760408044` may be called, plus Tinyman
  `1002541853` when the SDK routes a swap for the $U leg.
- **Allowed assets**: an enumeration *we* build — `{ALGO, 3760411000,
  3081853135}` — never "whatever the group names". Same rule and same failure
  mode as `pinnedPoolAssets`.
- **value_leaves**: every outbound destination must be the dualSTAKE app
  address or, for the swap leg, Tinyman's. Nothing may leave to anywhere else.
- **Amount bound**: the ALGO leg must equal what the user typed, to the
  microALGO. The $U leg must be within a tolerance of our own independent
  computation from `getRate()` — we do not re-derive it for the build, but we
  do check it, which is the whole point of an assertion.
- **Fee cap**, as the PEX paths have.
- **No rekey**, no close-out, on any transaction. (Learned in mVote I-5.)

Then a MainNet **simulation** before signing. Nothing ships without it.

## 4. Reads and the figures on the card

| Figure | Source |
|---|---|
| Rate / $U per magnetALGO | `getRate()`, `ratePrecision` |
| Total staked | `staked` |
| Cap headroom | `max_balance − staked` |
| Your magnetALGO | account holding of 3760411000 |
| Your position value | holding × 1 ALGO + accrued $U |
| Yield | **See §6 — do not invent one** |

## 5. The card, modelled on C-Vault

Same `CardShell`, drifting blob, display heading with `glow-text-card`, and a
rate box. The C-Vault card shows *Pool liquidity, Participants, Shares
outstanding, Your position, Your shares, Your share of pool, Unrealized
gain/loss*; the dualSTAKE analogues are:

| C-Vault | dualSTAKE |
|---|---|
| Pool liquidity | Total staked (ALGO) |
| Shares outstanding | magnetALGO circulating |
| Your shares | Your magnetALGO |
| Your position | 1 ALGO per token + accrued $U |
| Unrealized gain/loss | Accrued $U, valued |
| — | Cap headroom |

It sits under the **Vaults** pill beside the C-Vault, in the existing two-up
grid, which was built so a new strategy lands beside the first without
touching the layout.

### Copy rules

- **Never quote the ratio alone.** "1:1" is true of the ALGO and false of the
  holding. Always *1 ALGO + accrued $U*.
- State the **650 bps** total fees (250 platform + 400 node runner).
- State that this is a **third-party contract**: upgradeable with a **1-week
  timelock**, pre-published code hashes, and a protest mechanism; dissenters
  can redeem immediately. Materially better than unqualified "upgradeable",
  and still not our own audited code — say which it is.

## 6. The open question the card must not answer by guessing

We do not yet have a defensible **APR**. The yield is consensus rewards swapped
into $U through a ~$9.5K Tinyman pool, so realised yield depends on harvest
slippage, which grows with TVL. One observed redemption is not an annualised
rate and must not be presented as one.

Until there is a measured series, the card shows accrued $U and the mechanism,
and **no APR** — the same withhold-rather-than-guess rule the perps terminal
applies to an unpriced payout.

## 7. Order of work

1. Take the dependency; resolve the licence question.
2. `reads.ts` + `config.ts`, verified against the chain figures already in
   OVERVIEW.md.
3. `group.ts` assertion, with mutation tests.
4. `client.ts` wiring the SDK composer to `use-wallet`.
5. MainNet simulation of mint and redeem on real bytes, nothing signed.
6. Independent audit: fund safety, and figures-on-screen.
7. Card, rasterised at 1440 and 360.
8. Founder canary: one small real deposit and redemption before announcing.
