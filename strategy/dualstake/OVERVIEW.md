# magnetALGO dualSTAKE — Myth Finance

_Status: **investigated, not built.** Everything below was measured against
mainnet on 2026-11-06, not taken from documentation._

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

**Deposit — `mint()void`, selector `5588dcb4`.** Group of 3 (2 once opted in):

```
[0] axfer  0 magnetALGO, self -> self        (opt-in; first time only)
[1] appl   mint() on 3760408044, fee 2000
             foreignAssets [3081853135, 3760411000], 1 account
           inner: axfer magnetALGO  app -> user
[2] pay    ALGO  user -> app address
```

Observed: 2.000000 ALGO in, 2,000,000 magnetALGO out. Total group fee
4,000 µALGO. Note the payment is LAST.

**Exit — `redeem()void`, selector `27172f4a`.** Observed group:

```
[n] axfer  magnetALGO  user -> app address
[n] appl   redeem() on 3760408044, fee 5000
             inner: axfer $U    app -> user     (accrued rewards)
             inner: pay   ALGO  app -> user     (principal)
```

Observed: 353,286,105 magnetALGO redeemed for **353.286105 ALGO (1:1) plus
11,020 µ$U of accrued rewards**.

**This is the finding that matters most.** There is a direct redemption path,
so an exit does not depend on the U/uALGO Tinyman pool — which holds only
~$9.5K and could not absorb a meaningful position. A card built on this is not
selling users into an illiquid exit.

## Answering "is there an MCP or SDK?"

No Myth MCP is available, and none is needed. The group shapes above are
measured from real mainnet transactions, which is the same basis the PEX
integration is built on and a better one than a vendored SDK: it is what the
contract actually accepts today, not what a library claims it accepts.

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
