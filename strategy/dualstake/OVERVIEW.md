# magnetALGO dualSTAKE — Myth Finance

_Status: **built, audited and live** on the Strategy page's Vaults pill.
Built against Myth's official TypeScript SDK — see "Use the SDK, not my
reverse-engineering" below, which is still the most important section in this
file._

_Revised 2026-11-07: the card's prose moved into a **Learn more** modal
shaped after the C-Vault's, and it now shows a **staking rate**. See
"The rate on the card" below, and [SPEC.md §7–8](./SPEC.md)._

| | |
|---|---|
| Code | `web/src/lib/strategy/dualstake/`, `web/src/components/strategy/dualstake/` |
| Spec | [SPEC.md](./SPEC.md) |
| Hermetic tests | `group.test.ts`, `amount.test.ts`, `depositGuards.test.ts`, `reads.test.ts` |
| MainNet tests | `web/src/lib/strategy/__live__/dualstake.live.test.ts` |

## What it is

Deposit ALGO with Myth Finance, receive **magnetALGO** (ASA `3760411000`, unit
`uALGO`), a liquid staking token whose rewards accrue in **$U** rather than
ALGO. Myth's own description: "ALGO+U dual staking … enables rewards that
accrue in U instead of ALGO."

That is an unusually good fit for this protocol — it is ALGO staking that pays
out in our own token, which means a dualSTAKE depositor becomes a structural
buyer of $U. It is the strongest third-party alignment on the board.

| Fact | Value | Source |
|---|---|---|
| dualSTAKE app | `3760408044` | app address IS the magnetALGO creator |
| LST | `3760411000` magnetALGO / uALGO, 6dp | Pera, `verification_tier: verified` |
| Reward asset (`asa_id`) | `3081853135` — **$U** | app global state |
| Currently staked | ~49,319 ALGO | `staked` |
| Deposit cap (`max_balance`) | 65,000,000 ALGO | app global state |
| Platform fee | 250 bps | `platform_fee_bps` |
| Node-runner fee | 400 bps | `noderunner_fee_bps` |
| Admin | `MYTHICALL…UMCNM` | `admin_addr` |

## Measured transaction shapes

**Deposit — `mint()void`, selector `5588dcb4`.** Minting takes **ALGO *and*
$U**, not ALGO alone. Myth's docs: "Users stake `X ALGO` + `Y ASA`, receiving
`X` dualSTAKE tokens."

Measured at round 66669741 — 60 magnetALGO minted:

```
[0] pay    0.019068 ALGO                      (fee for the swap below)
[1] appl   swap on Tinyman v2 1002541853      (acquiring the $U leg)
[2] axfer  0 magnetALGO, self -> self         (opt-in; first time only)
[3] appl   mint() on 3760408044
             foreignAssets [3081853135, 3760411000]
[4] pay    60.000000 ALGO   user -> app
[5] axfer  1,249 $U         user -> app       <-- the $U requirement
[6] axfer  60,000,000 magnetALGO  app -> user
```

`Y` grows as rewards accrue, because a new token must arrive backed by the
same $U per token as every existing one.

**Exit — `redeem()void`, selector `27172f4a`.** Observed group:

```
[n] axfer  magnetALGO  user -> app address
[n] appl   redeem() on 3760408044, fee 5000
             inner: axfer $U    app -> user     (accrued rewards)
             inner: pay   ALGO  app -> user     (principal)
```

Observed: 353,286,105 magnetALGO redeemed for **353.286105 ALGO plus 11,020
µ$U of accrued rewards**.

### The ALGO leg is exactly 1:1; the appreciation is the $U

Measured across every mint and redeem in the last 200 app transactions, at
sizes from 2 ALGO to 49,500 ALGO, the ALGO:magnetALGO ratio is
**1.00000000 on all five, both directions**. The ALGO side does not drift
upward the way a conventional LST's exchange rate does.

That is not the same as "magnetALGO is worth 1 ALGO". It is worth **1 ALGO
plus the $U accrued against it**, and that $U is paid as its own leg on
redemption. Describing it as "1:1" is accurate about the ALGO and misleading
about the holding, so UI copy should say *1 ALGO + accrued $U* and never the
ratio alone.

### Where the $U comes from — and why the Tinyman pool is load-bearing

Selector `93239802` is the harvest. Measured at round 66654225, its inner
transactions are: take the accrued consensus rewards (7.555326 ALGO in that
call) and swap them through **Tinyman v2 app `1002541853`** — the U/uALGO
pool — into $U, which is then what redeemers are paid.

Two consequences, and the second corrects an earlier reading of mine:

1. **This is standing, automated $U buy pressure funded by consensus rewards
   on the whole staked balance** (~49,319 ALGO today), recurring for as long
   as the product has TVL. It is a materially stronger alignment argument than
   "rewards happen to be denominated in $U".

2. **The U/uALGO pool is NOT incidental.** User exits genuinely do not depend
   on it — `redeem()` pays ALGO straight from the contract — but the entire
   yield does, because that pool is the conversion venue. An earlier draft of
   this document treated the pool as unimportant to the product on the
   strength of the exit path. That was wrong.

   The pool holds ~$9.5K. As dualSTAKE TVL grows, each harvest pushes more
   ALGO through it, and slippage comes straight out of the yield delivered to
   magnetALGO holders. That gives Magnet a concrete, self-interested reason to
   deepen that pool beyond the farm incentive already planned — it is the
   throughput limit on the product's entire return.

## Use the SDK, not my reverse-engineering

**There is an official path and it must be used.** Myth publish
[dualSTAKE documentation](https://docs.myth.finance/dualSTAKE/overview) with a
"For Developers" section containing a **TypeScript SDK**, and a
`dualSTAKE-ts-sdk` repository under [github.com/MythFinance](https://github.com/MythFinance/).

The first draft of this document reverse-engineered the group shapes from
five on-chain transactions and asserted that a deposit was "ALGO in, no SDK
needed". **That was wrong, and measurably so.** Three of those five mints
carried no $U leg — but only because they happened at zero accrual: one was
Myth's own 49,500 ALGO seeding mint and one was on launch day. The next mint
in the record, at round 66669741, required 1,249 µ$U alongside 60 ALGO, and a
Tinyman swap to obtain it.

A builder written from that sample would have produced groups missing a
required asset transfer. It would have failed, which is survivable — but the
same error in the other direction, over-sending or mis-scaling `Y`, is not.

The lesson is narrower than "measure the chain", which is already repo
doctrine and is exactly what produced the wrong answer here: **a small sample
of a third-party protocol can be unrepresentative and still look conclusive.**
Where a vendor publishes a spec or an SDK, that is the authority, and chain
observation is how you verify it — not a substitute for it.

**Precedent, and the contrast that matters.** The PEX integration is not
reverse-engineered: Ultrade publish a protocol manifest to a public artifact
endpoint (`pex/manifest.ts` vendors it and pins its SHA-256), there is an
official SDK, and there was direct vendor contact — `quote.ts` carries
"Ultrade, 2026-09-28: do NOT use `collateral_delta`", which is the vendor
correcting us on a specific field. We have no equivalent relationship with
Myth yet, and should open one before shipping a card that moves user funds
into their contract.

## What must be disclosed on the card, and why

**The contract is upgradeable AND deletable by Myth.** Measured, not inferred:
the approval program compares `txn OnCompletion` against `4`
(UpdateApplication) and `5` (DeleteApplication), and global state carries
`contract_upgrade`, `fee_update` and `upgrade_period` = 604800 (7 days). So
there is an admin path behind what looks like a one-week timelock.

That is normal for a liquid staking protocol and is not a reason to refuse —
but it is categorically different from the contracts we write and audit
ourselves, and the card must not present it as though it were. A depositor is
trusting Myth's admin keys, and should be told so in those words.

Also worth stating plainly: fees total 650 bps across platform and node
runner, and the 65M ALGO cap is a real ceiling.

## What the audit found

Two independent agents reviewed the first working version with no shared
context — one on fund safety, one on the figures and copy. Both reported, and
every finding below was reproduced by hand before it was acted on. The
pattern is worth recording: **the serious defects were in what the assertion
did not check, not in what it checked wrongly.**

| Severity | Finding | Fix |
|---|---|---|
| High | `assertDualStakeGroup` never required an app call, so a lone `pay -> app` passed every check — the user's ALGO donated, no magnetALGO minted | pinned `MINT_SELECTOR` / `REDEEM_SELECTOR`, exactly one dualSTAKE call |
| High | `rewardToApp` was bounded on mint only, so a redeem could carry the user's entire $U balance to the app and pass `value_leaves` | redeem requires `rewardToApp == 0` |
| High | Nothing on the card said a deposit **costs $U**; a wallet without it met the requirement as a raw simulate failure | pre-checked balance and opt-in, cost shown in the preview and on the button |
| High | "$U accrued to you", tinted green, was the GROSS redeemable figure — it counted the user's own entry cost as profit | relabelled "$U on redemption", untinted |
| Medium | Only pay/axfer/appl were inspected; `keyreg`, `acfg`, `afrz` fell past every branch — a `nonParticipation` rider was irreversible | transaction-type whitelist |
| Medium | `onComplete` unchecked, so a Tinyman CloseOut or a dualSTAKE ClearState could ride along | every app call must be NoOp |
| Medium | The $U bound (`2 * est + 1000`) came from the SDK's own rate, so a wrong rate moved the ceiling and the amount together | `readRateIndependently` off raw algod; bound tightened to `est + 1% + 2` |
| Medium | `BigInt(Math.floor(n * 1e6))` truncated 1,196 of the two-decimal inputs under 1000 — typing `2.01` deposited 2.009999 | `amount.ts`, exact string-to-bigint |
| Medium | The fee line fell back to a hardcoded "6.5%" when the read failed, stating a figure we had not read | read live or not stated at all |
| Low | The pin check failed OPEN on deposit: `null` (unreadable) was treated like a match | deposit requires `=== true`; redeem still skips it entirely |
| Low | 4dp rounding rendered a non-zero holding as "0.0000" | `< 0.0001` |

Every new guard was mutation-tested: each was disabled in turn and the named
test confirmed to go red. A guard whose removal breaks nothing is not a guard.

## The rate on the card

The card showed no APR until 2026-11-07, on the grounds that the only
candidate was an extrapolation from our own short history. That reasoning
still holds and is what chose the figure now shown.

**Myth publish no rate.** Their SDK README says so of both contract views —
*"Neither includes APR or farm info"* — and their docs give no number. So the
request to "pull the yield from Myth's SDK" could not be met as put; the
figure is derived from live chain reads instead, and the modal shows the
derivation rather than asserting the result.

**What it is.** Algorand consensus rewards on the staked balance, net of
Myth's fee: `blocksPerYear × payoutPerBlock / onlineStake`, times
`1 − feeBps/10000`. Every input is read live. Measured 2026-11-07: 4.83%
gross, **4.51% net**. The derivation is identical for every eligible account
regardless of stake, which is why it carries no sampling error.

**Why not a trailing realised figure.** Block proposal is a Poisson process
and ~49.9K ALGO expects **0.8 proposals a day** — three had happened when this
shipped. Annualising three samples carries about ±58%, the same objection that
kept an APR off the card in the first place. The realised harvests are shown
in the modal instead, unannualised, so the spread is visible rather than
hidden behind one figure.

The two agree inside the band: 4.83% expected against 6.00% realised gross
over 3.00 days. A MainNet test asserts they stay the same order of magnitude.

**A reconciliation worth keeping.** Myth's fee comes off *before* the ALGO →
$U swap, so the amounts in the harvest log are what holders actually received.
Proved arithmetically rather than assumed: 22.864667 ALGO swapped against fee
counters of 1.589520, and `1.589520 / (22.864667 + 1.589520) = 0.065000`
exactly — 650bps, to five figures.

### One test expired while this was built

`"holds enough $U and ALGO to redeem every token outstanding"` asserted the
$U surplus was "a whole base unit or less". It was, when written; it was five
on 2026-11-07 and failed. Nothing had broken — `mintRewardCost` rounds the $U
leg **up** by one base unit on every mint, so the surplus grows by one per
deposit, forever. A constant bound on a monotonically growing quantity was
always going to expire.

Now relative: the surplus must stay a negligible share of the balance, which
holds at five mints or five thousand. Second time a pin like this has expired
here — see "Temporary gates expire".

## Still open

1. **The SDK's licence contradicts itself.** `package.json` declares
   `"license": "BSL"`; the shipped `LICENSE` file is verbatim MIT with an
   unfilled `<copyright holders>` placeholder. BSL normally restricts
   production use and MIT does not, so the grant we are relying on is
   genuinely ambiguous. **Ask Myth**, and pin the dependency exactly
   (currently `^3.3.10`) in the meantime.
2. **Open a vendor line to Myth.** The licence above is a question only they
   can answer, and the Ultrade relationship is the reason the PEX integration
   is trustworthy.

## Closed since the audit

**Exit does not depend on pool liquidity.** Both audits flagged the card's
"no dependence on pool liquidity to exit" as unsubstantiated and it was
removed. That was right on the evidence available and wrong as a conclusion.
The founder confirmed the mechanism — redemption is fixed per token, locked
ALGO plus $U, straight from the contract — and it is verifiable without
taking anyone's word for it.

`rate` is defined as `asaBalance / staked`, so the $U owed is derived from the
$U the contract already holds. Measured 2026-11-07: if every token outstanding
redeemed at once the contract would owe 1,538,506 base $U against 1,538,507 on
hand, and its ALGO balance (49,321,369,374 µALGO) covers `staked`
(49,319,479,854) outright. A payout computed from the balance can never exceed
it, so no swap is ever needed to fund an exit.

What misled the audits — and me — is that Myth's docs say the reward swap runs
before a mint *or* a redeem, and the SDK passes Tinyman as a reference on both
paths. Both are true; neither bears on the payout. The swap tops up accrual, it
does not fund the exit. Two sampled redemptions carried `axfer, pay` inner
transactions and no app call, consistent with that, though the structural
argument is what settles it — per
[[feedback-vendor-spec-beats-sampling]], two observations would not.

The claim is now pinned by a MainNet test ("holds enough $U and ALGO to redeem
every token outstanding"), so if Myth redefine the rate the copy fails a test
rather than quietly becoming false.

**Sunsetting is not a risk here.** Myth disable minting and rewards
eligibility below 30,000 ALGO staked for four weeks. The ~49,319 ALGO staked
is the founder's own and is not being withdrawn, so the threshold is not in
play. Not disclosed on the card.

## Open question for the founder

The economics are attractive and the alignment is unusual, but this would be
the first card that deposits into a contract **we do not control and cannot
audit the upgrade path of**. That is a positioning decision as much as an
engineering one, and it should be made deliberately rather than inherited from
the fact that the integration is easy.
