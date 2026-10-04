<!--
Drafted 2026-09-29, NOT yet sent.

DOWNGRADED 2026-10-04: this no longer blocks anything. The close write path is
built and signed on MainNet — 7 transactions, 20.87 xALGO recalled — by building
the yield registry from chain state instead of waiting on an answer. What remains
is a confirmation of two details: the xALGO provider fee credit
(XALGO_PROVIDER_FEE_CREDIT_MICRO_ALGO = 20,000, the only invented value in the
registry) and whether proposer addresses must be supplied. Worth sending, but it
is no longer on the critical path.
-->

Morning Dan — following your "always use recall" answer, I got most of the way
and hit one value I can't source. Short question, then the working.

**Is `xalgo_provider_fee_credit_per_call_microalgos` stable enough for us to
pin, and what is it for ALGO/USD (market 1)? If not, is
`/v2/market-yield/action-recall-plan` the intended way for a frontend to get
it?**

## What we established

Recall really is required, as you said. `decrease_or_close` with
`yieldRecallMode: 0` builds fine and then fails in simulation at
`inner tx 0` on a live ALGO/USD long — so the no-recall path is not an option
even when it looks like one.

With `yieldRecallMode: 1` the build throws:

    marketYieldRegistry is required for xALGO action recall

Tracing it: `withV2ActionXalgoProviderFeeCredit` only fires when a recall cap
lands on native ALGO, which for an ALGO/USD long is always — the PnL leg pays
in ALGO. It then reads exactly one field out of the registry's matching
strategy, `xalgo_provider_fee_credit_per_call_microalgos`, and uses it solely to
raise `flatFeeMicroAlgo`. Nothing else on that path touches the registry.

We can already source everything else locally. The recall caps come from our own
close quote — `primary_output_amount` and `pnl_output_amount` aggregated by
asset, per your last answer — so we do not need the plan to size the recall. And
`mxac:` on the xALGO vault carries the rest of the strategy config on chain.

It is that single fee-credit value that is not in any box we can find.

## Since drafting: we think we can avoid the endpoint

We traced what the registry is actually used for, and it is app ids, asset ids
and box keys — configuration rather than live state. `mxac:` gives us the
consensus app and xALGO asset, `yc2:` gives the Folks pool and f-asset, and the
rest we already pin. The only field with no on-chain source is the fee credit
above, and since it only raises `flatFeeMicroAlgo` we can over-provision it and
let simulation confirm sufficiency.

So this is no longer a blocker — it is a request to confirm a constant, plus one
extra question: **do `xalgo_proposer_addresses` need to be supplied for a
recall, and if so where should a frontend read them from?** They are in neither
box we found.

## Why we would rather not call the endpoint

Our frontend has no backend and takes no live dependency that shapes a signed
transaction. The oracle is the one external read, and it is a **static published
file** on R2 — no server, no request that could return a different answer to
different callers.

`action-recall-plan` is a POST to a live service whose response would feed into
a group the user then signs. That is a different trust shape, and we would
rather not add it for one constant if that constant is stable. If it is stable,
we pin it next to the app ids and the manifest hash, and a change fails our
preflight loudly rather than silently.

If it is not stable — if it tracks a real cost that moves — then the endpoint is
the right answer and we will wire it, and we would just want to know whether it
is intended to be called keylessly from a browser.

Happy to send the exact group and the simulation output.
