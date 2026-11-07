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
  yield.ts     the APR: network parameters in, expected consensus rate out (§8)
  events.ts    the harvest log, decoded by the SDK's own ARC-28 parser (§8)
  group.ts     the pre-sign assertion (§5)
  client.ts    deposit / redeem: SDK builds, we assert, chain simulates, user signs
web/src/components/strategy/dualstake/
  DualStakeCard.tsx      the card: rate box, stats, action, one-line disclosure
  DualStakeActions.tsx   deposit / redeem form
  DualStakeAbout.tsx     the Learn more modal — mechanism, derivation, risks
```

Tests: `group.test.ts`, `amount.test.ts`, `depositGuards.test.ts`,
`reads.test.ts`, `yield.test.ts`, `events.test.ts`,
`DualStakeCard.test.tsx`, and `__live__/dualstake.live.test.ts` on MainNet.

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
| Staking rate | **§8** — derived, and the modal shows the derivation |
| Total staked | `staked` |
| Capacity left | `max_balance − staked` |
| Your magnetALGO | account holding of 3760411000 |
| $U on redemption | `holding × rate / ratePrecision` |

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

## 7. What goes on the face, and what goes behind Learn more

The card carried its whole argument on its face until 2026-11-07: a mechanism
panel, a paragraph on why no rate was shown, and a four-sentence amber
disclosure. Nothing in it was wrong and all of it was longer than the figures
a depositor came for — it was the tallest card in the grid by enough that
`items-start` had to be added to the grid so the C-Vault beside it did not
stretch to match.

It now follows the C-Vault's division, because the two cards sit side by side
and a shared frame is the thing that makes a page read as one shelf:

| On the card | Behind **Learn more** |
|---|---|
| Heading, one-line summary | What dualSTAKE is, and whose it is |
| The rate box (§8) | How it earns, and the rate's full derivation |
| Four stats | Every harvest, unannualised |
| Deposit / redeem | Minting's $U cost; how redemption works |
| *"This is Myth Finance's contract, not ours"* | "What you carry" — six risks, in full |

**One sentence of disclosure stays on the face.** "Not ours" is what a
depositor must know before pressing the button, so it lives beside the button.
The upgrade path, the fee, the ceiling and the rest moved; none was deleted,
and `DualStakeCard.test.tsx` asserts each moved claim is present *inside the
opened modal* rather than trusting that it arrived.

Both triggers carry an `aria-label` naming their product. The visible words
stay "Learn more" on all of them, but three buttons reading only "Learn more"
are indistinguishable in a screen reader's button list — and were ambiguous to
the test suite first, which is how it was noticed.

## 8. The APR, and why there finally is one

### Myth do not publish one

Checked 2026-11-07, both sources. The SDK's README, on `DSContractListing`
and `DSContractState`: *"Neither includes APR or farm info."*
`docs.myth.finance/dualSTAKE` mentions "dualSTAKE farms offering higher APR
(where available)" and gives no number. There is no vendor figure to read, so
the card derives one or shows none.

### The derivation

The yield is Algorand consensus rewards. The contract is online and incentive
eligible, so each time it proposes a block it collects the proposer payout;
Myth take their fee and the remainder is swapped ALGO → $U.

A staker's expected annual reward is
`(stake / onlineStake) × blocksPerYear × payoutPerBlock`, and dividing by
`stake` cancels it:

```
grossApr = blocksPerYear × payoutPerBlock / onlineStake
netApr   = grossApr × (1 − (platformFeeBps + noderunnerFeeBps) / 10000)
```

**The same for every eligible account, regardless of size.** All four inputs
are live reads — three from algod (`/v2/status`, `/v2/ledger/supply`, and
nine block headers), the fees from the contract's own state. Measured
2026-11-07: 8.186062 ALGO per block, 2.714 s per block, 1.9705B ALGO online →
**4.83% gross, 4.51% net** of 650bps.

Block headers are fetched with `?header-only=true` — 1.1KB against 5.7KB for
a quiet block and far more for a busy one. algosdk has no binding for it, so
`yield.ts` uses `fetch` directly.

### Why expected, and not a trailing realised figure

Because block proposal is a Poisson process and this stake is small. At ~49.9K
ALGO against 1.97B online the contract expects **0.8 proposals a day**, and it
had made three when this shipped. Annualising three samples carries roughly
±58% — which is the same objection that kept an APR off this card originally,
applied to the only other candidate.

The expected figure has no sampling error: it is an expectation over the
network's parameters, not an extrapolation from our own history. The two agree
inside the band — 4.83% expected against 6.00% realised gross over 3.00 days —
and a MainNet test asserts they stay the same order of magnitude, which is
enough to catch a decimals slip or a misread block time and is not claimed to
be more.

**So the earlier "no APR" position is not reversed; its reasoning is what
chose this figure.** What changed is that a second candidate existed.

### The harvest log is the realised side

Every reward that reaches a holder passes through one ARC-28
`swap(uint64,uint64)` event. `events.ts` reads them through the SDK's own
`getParsedArc28EventsFromTransaction` — the vendor's spec and the vendor's
decoder, not a hand-rolled prefix table that could drift from it.

**`algo_amount` on a swap is already net of Myth's cut.** Verified
arithmetically: 22.864667 ALGO swapped against `platform_fees` +
`noderunner_fees` of 1.589520, and `1.589520 / (22.864667 + 1.589520) =
0.065000` exactly. So the modal presents those figures with nothing further
deducted.

**The scan pages to exhaustion, and reports truncation.** It was a single
`limit: 300` call under the heading "Every harvest so far" — true at three
harvests in ninety transactions, and due to stop being true silently, because
deposits are what fill that window. `readHarvests` now follows the
continuation token up to 12 pages of 1,000 and returns
`{ harvests, complete, scanned }`; when `complete` is false the modal retitles
to "Recent harvests", names its window, and stops calling the count a total.
Third bound of this shape to need fixing here, so the loop carries its own
hermetic tests against a faked indexer — the live contract has under one page
and cannot exercise it.

**It is read when the modal opens, not on card mount.** The cost grows with
the product and nothing on the card's face shows it, so the reader who presses
Learn more is the one who pays. Fetched once per mount.

The modal shows them **unannualised, with no day count**. An earlier draft
read "over 1.3 days", which is first-harvest to last — a window with a harvest
at each end, excluding the dry stretches either side, so dividing by it
overstates the rate. It sat two lines above the card's 4.46%, which is an
invitation to do exactly that division.

### Three states, and none is a number we did not read

| State | Renders |
|---|---|
| read, node earning | the figure, green |
| read, node **offline** | the figure **struck through**, and why |
| unread | `—` |

The offline case is the one that needed building. `grossAprPct` describes the
*network*, so it reads perfectly well while this contract earns nothing — the
single state in which a confident green 4.5% is flatly false. A null snapshot
is *unknown* and must not produce it either: asserting an outage we never
observed is its own error.

## 9. Verifying a change here

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
