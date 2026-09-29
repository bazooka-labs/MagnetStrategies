<!--
Drafted 2026-09-28, NOT yet sent. Raised by the audit-7 remediation review.

Blocks: itemising the exit-cost breakdown in the positions panel. The panel
currently shows ONE net figure (the exact difference between the payout and the
collateral) rather than a five-field decomposition, because the decomposition
did not add up. Not a correctness problem in the headline — `payoutUsd` is
right, per Dan's 2026-09-28 answer — only in explaining it.
-->

Morning Dan — a smaller one than the last, and it follows directly from your
answer about aggregating the outputs.

That answer fixed our payout. We then tried to show the user *why* the payout
differs from their raw price move, itemised from the quote's own fee fields, and
it doesn't reconcile. Measured against all 8 live `p2:` positions on 3690309166's
Trading app today.

What we expected:

    net = pnl − close_fee − builder_fee − funding − borrowing + impact

On the 3 shorts that holds to within half a cent. On all 5 longs it is out, and
the whole residual is the funding term:

    position     collateral   residual    funding field says   chain settled
    DGJOWLTV      $5.501681   +0.177165   cost  $0.097121      credit $0.076496
    J65HYZUN      $5.065699   +0.164184   cost  $0.032466      credit $0.129771
    E3XQNHM7     $16.503090   +0.138851   cost  $0.056736      credit $0.076513
    KNML6OW2      $5.858426   +0.018395   cost  $0.000000      credit $0.016718
    KANJIGXR     $66.650103   +0.020816   cost  $0.000000      credit $0.021362

"Chain settled" there is `collateral_delta − collateral_amount`, which
reconciles exactly on every one of the 8 — e.g. DGJOWLTV,
`5501681 + 76496 = 5578177 = collateral_delta`.

So on these longs funding was **credited** to the trader, and
`funding_fee_collateral_amount` reports a cost of a different magnitude. Our
guess is that it is only the collateral-denominated half of the settlement, and
the rest arrives through the token-denominated claimable-funding path
(`long_token_claimable_funding_per_size_for_longs` and friends) — which would
explain why shorts tie and longs don't, since our long markets pay PnL in the
index asset.

Two questions:

1. Is `funding_fee_collateral_amount` intended to be the whole funding
   settlement for a position, or only the part settled in the collateral asset?
2. If the latter — is `collateral_funding_net_amount` the field we should be
   showing, or should we derive it the way we currently verify it, from
   `collateral_delta − collateral_amount`?

No urgency: we've shipped the net figure alone rather than an itemisation we
can't derive, so nothing user-facing is wrong while this is open. Happy to send
the full per-position dump.
