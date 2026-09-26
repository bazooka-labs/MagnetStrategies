<!--
Drafted 2026-09-26, NOT yet sent. Kept in the repo rather than a scratch
directory on purpose: the audit harnesses were lost that way once already.

Two open questions go to Ultrade, and only the first is written up here:
  1. B6 — OrderOps rejects the attached take-profit leg (below).
  2. `doi:` has no declared format in the protocol manifest, so our layout for
     it is pinned against nothing. Worth adding to the same message.

Context and eliminations: strategy/perps/AUDIT.md, the B6 section.
-->

Morning Dan — one blocker on our side, and I've narrowed it as far as I can.

We can't get an attached take-profit accepted by OrderOps. Simulation fails at:

    app 3690309166 (PDexV2OrderOps), pc=8175
    opcodes=bz label191; intc_1 // 1; label193:; assert

Built with @pdex/sdk 0.6.3's own `buildV2MarketOpenWithAttachedOrdersTransactions`,
9 transactions, against MainNet.

What I've eliminated — all give the identical pc=8175:

  - builder fee present vs omitted entirely
  - keeper fee 0.10 vs 0.25 USDC
  - baseOrderId 1 vs 9000
  - storagePaymentMicroAlgo 99,700 / 129,000 / 29,300
    (tested the V2_TRADER_BOX_MBR theory — the account has a t2: box on
     Trading but none on OrderOps; funding it changes nothing)
  - market 2 where the account holds no position, and market 1 where it
    already holds one, both sides

What works: the identical open WITHOUT the attached take-profit simulates
ok=true for the same account, and a trivial self-payment as that account
simulates fine. So it isn't a signature artefact of simulating a third
party, and it isn't an account prerequisite — it's the attached-order leg.

From an exec trace, the order args reaching the contract look right:

    orderKind=2 (DECREASE_TAKE_PROFIT), marketId=2, collateralAssetId=31566704,
    side=1, trigger=96939307500000000, acceptable=96454610962500000,
    keeperFeeAssetId=31566704, linkMode=3 (CHILD_ACTIVE), linkBaseOrderId=1

acceptable is below trigger, which is the side v2OrderPriceCoherenceFailure
requires for a long take-profit. Immediately before the assert the trace shows
a box read returning empty:

    pc=8163  pushes=[0x]      <- empty
    pc=8165  pops=1
    pc=8175  assert -> fail

So something the contract expects to exist doesn't. The OrderOps call carries
box refs for o2: (its own, being created) and Trading's p2:, plus two empty
budget slots.

Two things that might be context rather than coincidence: OrderOps currently
holds **zero boxes exchange-wide**, and we've never observed v2_order_executed
on MainNet — though 49 bracket cleanups are on chain historically, so orders
clearly worked at some point.

Question: what does a valid submit_linked_order need that an SDK-built
open-with-attached-orders group doesn't carry? Is there a registration or
initialisation step on OrderOps we're missing, or has something moved since
these last worked?

Happy to send the full group, the trace, or a reproduction script.
