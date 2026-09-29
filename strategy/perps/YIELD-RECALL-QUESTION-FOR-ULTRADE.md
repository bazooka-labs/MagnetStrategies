> **ANSWERED 2026-09-29.** Ultrade: *"generally speaking, I would suggest always
> using recall because most of the time the yield deployment doesn't leave much
> idle assets… that's the safest way to ship without complicating the code or
> waiting."*
>
> So: always pass `yieldRecallMode: 1` rather than deriving whether a recall is
> needed. The SDK attaches the recall resource carriers itself. This **unblocks
> the close write path**; what to do about it is in [NEXT.md](./NEXT.md#1-close-write-path--unblocked-and-now-the-only-large-gap).
> Kept below as the question and the evidence that produced it.

---

<!--
Drafted 2026-09-28, NOT yet sent. Kept in the repo rather than a scratch
directory, same as the other Ultrade questions.

This is the last thing gating the close WRITE path. Reads, quoteClose and
assertCloseGroup are built and tested; we have not shipped a Close button
because of the question below.

Context: strategy/perps/AUDIT.md.
-->

Thanks — that answers the settlement question completely, and we've taken 0.6.6.

One more, and it's the last thing blocking us from shipping a Close button.

**We run no backend.** The manifest is vendored and pinned, prices come from your
public artifacts, everything else is read from chain. `buildV2DecreaseOrCloseTransactions`
needs `yieldRecallMode`, and the supported way to obtain it —
`prepareV2DecreaseOrCloseInput` — takes a `MarketYieldActionRecallClient`, which
is your API. So today we pass `yieldRecallMode: 0` directly, and groups build and
simulate fine.

What we can't tell is whether that's correct in general or just correct right
now. Reading `my2:` on Markets:

```
m1 ALGO  mode=1 kind=2  deployed=6,855,049,989  receipts=5,590,339,707  available=0
m1 USDC  mode=1 kind=1  deployed=1,119,675,574  receipts=900,422,567    available=716,842,336,790
m2 ALGO  mode=1 kind=2  deployed=8,685,918,766  receipts=7,084,113,936  available=0
m2 USDC  mode=1 kind=1  deployed=1,219,114,857  receipts=980,750,504    available=716,856,316,813
```

The USDC legs have plenty available, which we assume is why mode 0 works. **The
ALGO legs show zero.**

That matters more than we first thought, because of what you just told us about
outputs. Aggregating `primary_output_amount` and `pnl_output_amount` by asset on
a live ALGO/USD long gives:

```
15.88 ALGO  +  5.57 USDC
```

The profit is paid in ALGO — the asset whose strategy is showing
`observed_available_underlying = 0`.

So:

1. **Can pool state make a recall mandatory for a pair close?** Specifically,
   when the payout includes ALGO and the ALGO strategy has nothing available, is
   `yieldRecallMode: 0` still valid, or does that close need a recall we cannot
   compute without your API?

2. **If a recall can be required, is there a way to determine that from chain
   state alone?** We're happy to read whatever boxes it takes. What we'd rather
   not do is ship a Close button that works until the day it doesn't.

3. **If it genuinely requires your backend,** we'd like to know that plainly so
   we can decide how to handle it — a hosted read-only endpoint we call just for
   the recall plan would be acceptable; silently depending on one would not.

This is on the exit path, which is why we've held rather than shipped. A user who
can open and can't close is the one outcome we're not willing to risk, and right
now every position on the exchange can only be exited by its take-profit firing.

Separately, thank you for the storage-credit detail — that's clear, and we'll
build `withdraw_storage_credit` and `close_storage_account` against the generic
builders with simulation to check resources, as you suggested.
