# magnetALGO dualSTAKE — Myth Finance

_Status: **investigated, not built.** Build against Myth's official
TypeScript SDK — see "Use the SDK, not my reverse-engineering" below, which is
the most important section in this file._

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

## What building it would take

Not a small card. It moves user funds into a third-party contract, so it needs
the same discipline as the PEX paths:

0. **Read Myth's SDK and minting docs first**, and get the `Y` ($U requirement)
   calculation from their specification rather than inferring it. Open a line
   to Myth, as we have with Ultrade.
1. `lib/strategy/dualstake/` — client, group builder, chain reads for rate,
   `staked`, cap headroom and the user's position.
2. A group **assertion** of the kind `pex/group.ts` provides: pinned shape,
   pinned app id, pinned asset ids, an allowed-asset enumeration we build
   ourselves, a fee cap, and a `value_leaves` rule binding every destination
   to the dualSTAKE app address.
3. Live MainNet simulation proving build + assert + simulate on real bytes,
   both mint and redeem, before anything is signed.
4. An independent audit pass, per "no hot fixes on money paths".
5. The disclosures above, on the card rather than in a doc.

## Open question for the founder

The economics are attractive and the alignment is unusual, but this would be
the first card that deposits into a contract **we do not control and cannot
audit the upgrade path of**. That is a positioning decision as much as an
engineering one, and it should be made deliberately rather than inherited from
the fact that the integration is easy.
