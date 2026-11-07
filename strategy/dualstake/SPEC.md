# magnetALGO dualSTAKE — Implementation Spec

Mechanism detail for the Myth Finance integration: group shapes, selectors,
the assertion's invariants, and the decimals rule. **Status and open items are
in [OVERVIEW.md](./OVERVIEW.md)**, not here.

Everything below was measured against MainNet or read out of Myth's SDK
source. Where a figure is quoted it carries the date it was read, because the
contract's state moves.

## 1. The recipe is Myth's, not ours

| | |
|---|---|
| SDK | `@myth-finance/dualstake-ts-sdk` **3.3.10** |
| Docs | `docs.myth.finance/dualSTAKE` — `mint`, `redeem`, `rate`, `abi`, `ts-sdk`, `immutability`, `protesting` |
| Peer deps | `algosdk >= 3.4.0`, `@algorandfoundation/algokit-utils ^9.0.0`, `js-sha512 ^0.9.0` |

**Use `makeMintTransactions` / `makeRedeemTransactions`, never `mint()` /
`redeem()`.** The latter build *and send*. We need the composer so the group
can be asserted by us and then signed by the user's wallet through
`use-wallet`, which is how every other signing path in this app works.

**The SDK computes the $U leg.** Minting is "X ALGO + Y $U", and getting Y
wrong is exactly the error an earlier reverse-engineered draft made (see
OVERVIEW.md). `makeMintTransactions` takes only `algoAmount` and derives Y
itself. We do not re-derive it for the build — we **bound** it, which is a
different thing and is the whole point of an assertion.

## 2. Group shapes, as the SDK builds them

Measured 2026-11-06 against MainNet. Fees are flat minimums.

**Mint — selector `5588dcb4`, `mint()void`**

```
[0] axfer  0 magnetALGO, self -> self     fee 1000   (opt-in; only if needed)
[1] appl   mint() on 3760408044           fee 2000   onComplete NoOp
             appRefs    [tinymanAppId]
             assetRefs  [$U, magnetALGO]
             acctRefs   [lpId]
[2] pay    N microALGO  user -> app       fee 1000
[3] axfer  Y base $U    user -> app       fee 1000   (only while rate > 0)
                                   TOTAL  5000
```

**Redeem — selector `27172f4a`, `redeem()void`**

```
[0] axfer  0 $U, self -> self             fee 1000   (opt-in; only if needed)
[1] axfer  M magnetALGO  user -> app      fee 1000
[2] appl   redeem() on 3760408044         fee 3000   onComplete NoOp
             inner: axfer $U    app -> user    (accrued)
             inner: pay   ALGO  app -> user    (principal)
                                   TOTAL  4000-5000
```

The SDK passes Tinyman and the LP account as **references** on both paths. It
does not add a swap transaction to the group; the contract may swap
internally. Two sampled redemptions carried only the two inner transactions
above and no inner app call.

### The $U leg

```
asaAmount = algoAmount * rate / ratePrecision      // SDK, dualstake-client.js
if (rate > 0) asaAmount += 1                       // rounding, in the contract's favour
```

Reproduced as `mintRewardCost()` in `reads.ts` **only** to display the figure
and pre-check the user's balance. The transaction's amount always comes from
the SDK.

## 3. Rate, decimals, and the backing invariant

```
rate = ratePrecision * asaBalance / staked         // ratePrecision = 10^10
```

**The decimals trap.** magnetALGO has **6** decimals, $U has **5**, and `rate`
is defined base-unit to base-unit. Any conversion assuming matching decimals
is out by exactly 10x, on the one figure a depositor is here for. Apply the
rate in base units first, scale for display second, and never the reverse.
Pinned by `reads.test.ts` against a real redemption: 353,286,105 base
magnetALGO paid 11,020 base $U.

**Redemption is fully backed by assets on hand**, and this is why the card can
say there is no pool to exit through. Because `rate` is *derived from*
`asaBalance`, the $U owed if every token outstanding redeemed at once equals
the $U already held. Measured 2026-11-07: owed 1,538,506 base against
1,538,507 held, the one unit being floor rounding; ALGO balance
49,321,369,374 µALGO against `staked` 49,319,479,854. A payout computed from
the balance can never exceed it, so no swap can ever be needed to fund an
exit. Pinned by the MainNet test *"holds enough $U and ALGO to redeem every
token outstanding"* — if Myth redefine the rate, the copy fails a test rather
than quietly becoming false.

## 4. What we build

```
web/src/lib/strategy/dualstake/
  config.ts    pinned ids, program SHA-256, ARC-4 selectors, fee caps
  reads.ts     snapshot, holdings, mintRewardCost, readRateIndependently
  amount.ts    exact decimal text <-> base units (no floating point)
  group.ts     the pre-sign assertion (§5)
  client.ts    deposit / redeem: SDK builds, we assert, chain simulates, user signs
web/src/components/strategy/dualstake/
  DualStakeCard.tsx      the card
  DualStakeActions.tsx   deposit / redeem form
```

Tests: `group.test.ts`, `amount.test.ts`, `depositGuards.test.ts`,
`reads.test.ts`, and `__live__/dualstake.live.test.ts` on MainNet.

**`amount.ts` exists because floats lose base units.**
`BigInt(Math.floor(n * 1e6))` truncates 1,196 of the 100,000 two-decimal
values between 0.01 and 1000.00 — typing `2.01` deposited 2.009999 ALGO — and
a Max button that round-trips a holding through a float strands a base unit in
about 2% of holdings. Parse the digits.

## 5. The assertion — what it checks, and why each one

The SDK is Myth's code building a group that moves our user's funds. We assert
it before signing, as `pex/group.ts` does, because a dependency compromise or
an SDK bug must not be able to produce a signature.

**The first version checked destinations and amounts only, and that is a
filter, not a structure check.** A group of one `pay -> app address` satisfied
every rule it had: the user's ALGO donated to the contract, no magnetALGO
minted, and the chain would have accepted it. The guards marked ★ were added
after the audit; OVERVIEW.md has the full finding list.

| Guard | Rule |
|---|---|
| `shape` | 1–8 transactions |
| ★ `txn_type` | only `pay`, `axfer`, `appl` — a whitelist, so an unknown type cannot fall past every branch. A `nonParticipation` keyreg rider is permanent and irreversible |
| `sender` | every transaction sent by the user |
| `rekey` | no `rekeyTo`, anywhere |
| `close_out` | no `closeRemainderTo`, ALGO or ASA |
| `clawback` | no `assetSender` |
| `value_leaves` | every destination is the dualSTAKE app address, except a zero-amount self opt-in |
| `asset_unpinned` | assets limited to magnetALGO and $U, from an enumeration **we** build |
| `app_unpinned` | apps limited to dualSTAKE, Tinyman, ARC-59 |
| ★ `on_complete` | every app call is NoOp — a Tinyman CloseOut would destroy the user's position there |
| ★ `app_call` | **exactly one** call to dualSTAKE |
| ★ `selector` | carrying the pinned selector for the action requested |
| `fee_cap` | 15,000 µALGO on mint, 50,000 on redeem — see below |
| `amount` | the ALGO leg (mint) or magnetALGO leg (redeem) equals what the user typed, to the base unit |
| `reward_leg` | mint: the $U leg is within an independently computed bound |
| ★ `unexpected_leg` | redeem: `rewardToApp == 0`. A redemption pays $U **out** |

### Two asymmetries, both deliberate

**Fee caps differ by direction.** A real mint totals 5,000 µALGO and a redeem
4,000. The mint cap is tight at 15,000 because refusing a deposit is a safe
failure. The redeem cap stays at 50,000 because refusing an **exit** is the
dangerous one, and Myth's upgrade path contemplates extra AMM routes — more
inner transactions, a larger fee on the app call. A cap sized to today's shape
would stand between a holder and their own funds, which is the trap that cost
a live position two days on the perps path.

**The program pin blocks mint, never redeem.** A mismatch means the code
behind the user's ALGO changed; new money waits for a human, exits do not.
The pin also **fails closed on deposit**: `approvalMatchesPin` returns `null`
when it could not read, and treating that as a match let a network error stand
in for a verification.

### The $U bound must be independent

The bound was originally `2 * est + 1000` computed from the SDK's own rate
helper — so the ceiling and the amount it bounded came from the same code, and
a wrong rate moved both together. `readRateIndependently()` derives the rate
from raw global state and the app's asset holding instead, and the bound is
`est + 1% + 2`. The 1% covers the honest gap (a pending reward swap only fires
above ~1 ALGO of accrual); the old 2x permitted a doubled charge on a 100,000
ALGO mint — about 31 $U — to pass as normal. Excess $U is not credited to the
depositor.

A MainNet test asserts our independently derived amount **equals** the SDK's
$U leg exactly, which is what tells us if the two derivations ever drift.

Then a MainNet **simulation** before signing. Nothing ships without it.

## 6. The figures on the card

| Figure | Source |
|---|---|
| Total staked | `staked` |
| Capacity left | `max_balance − staked` |
| Your magnetALGO | account holding of 3760411000 |
| $U on redemption | `holding × rate / ratePrecision` |
| Yield | **§7 — do not invent one** |

A read that fails renders `—`, never `0`; `readHolding` returns `null` for
unknown and `0` only for a successful read of no holding. A non-zero amount
below the displayed precision renders `< 0.0001` rather than `0.0000`.

**"$U on redemption" is labelled gross on purpose.** `rate × holding` is what
a redemption pays out, and part of it is the $U the user themselves paid in at
mint. Labelling it "accrued" and tinting it green showed a depositor their own
entry cost as profit. Net accrual needs the rate at *their* mint, which the
chain does not expose per holder, so the card shows the gross figure under an
honest label rather than a net one it cannot compute.

### Copy rules

- **Never quote the ratio alone.** "1:1" is true of the ALGO and false of the
  holding. Always *1 ALGO + accrued $U*.
- **Say that minting costs $U.** The SDK opts the user into magnetALGO only, so
  a wallet with plenty of ALGO and no $U cannot deposit at all. The cost is
  pre-checked, named in the preview, and on the button.
- **Fees: read live or not stated.** 250 platform + 400 node runner = 650 bps
  today, and `fee_update_max_delta` 250 bps per `fee_update_period` of one week
  means Myth may raise them. A hardcoded fallback states a number we failed to
  read, which is the one thing every other stat refuses to do.
- **Say whose contract it is**: third-party, upgradeable behind a one-week
  timelock with pre-published hashes and a protest mechanism, dissenters free
  to redeem immediately. Materially better than unqualified "upgradeable", and
  still not our own audited code — say which it is.

## 7. The question the card must not answer by guessing

There is no defensible **APR** yet. The yield is consensus rewards swapped
into $U through a ~$9.5K Tinyman pool, so realised return depends on harvest
slippage, which grows with TVL. One observed redemption is not an annualised
rate and must not be presented as one.

Until there is a measured series the card shows the mechanism and the accrued
amount, states that no rate is shown and why, and gives **no APR** — the same
withhold-rather-than-guess rule the perps terminal applies to an unpriced
payout. An empty space would be filled by the reader's own guess, so the
absence is explained rather than left.

## 8. Verifying a change here

```bash
cd web
npx tsc --noEmit -p tsconfig.json
npx vitest run src/lib/strategy/dualstake                      # hermetic
npx vitest run --config vitest.live.config.ts \
  src/lib/strategy/__live__/dualstake.live.test.ts             # MainNet, signs nothing
```

Every guard in §5 is **mutation-tested**: disable it and the named test must
go red. A guard whose removal breaks nothing is not a guard, and this file's
table is not evidence that one works — the failing test is.
