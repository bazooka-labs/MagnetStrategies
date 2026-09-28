<!--
Drafted 2026-09-28, NOT yet sent. Kept in the repo rather than a scratch
directory, same as B6-QUESTION-FOR-ULTRADE.md.

Context: strategy/perps/AUDIT.md, audit 5 finding F7.
Blocks: the position-management UI's close preview for a PARTIAL close.
-->

Hi Dan — one question on `quoteV2DecreasePosition`, ahead of building our close
preview.

We're showing users a cost breakdown before they close, and we want the numbers
to add up for a partial close as well as a full one. Quoting the same live
position at 100% / 50% / 25% of `sizeUsdDelta`, some fields scale and some don't.

Position: `DGJOWLTV…` on market 1 (ALGO/USD), long, `size_usd = 5,500,000`.
Quoted through the SDK with `mf2:` supplied and the acceptable price anchored to
the execution price from a permissive first pass.

```
field                                      100%          50%          25%   scales?
collateral_delta                        5575525      2787762      1393881   yes
collateral_output_before_builder_fee     5572225      2786112      1393056   yes
close_fee_usd                              3300         1650          825   yes
effective_profit_usd                    2269478      1134739       567369   yes

collateral_funding_net_amount             73844        73844        73844   no
expected_collateral_credit                73844        73844        73844   no
funding_fee_collateral_amount             97132        97132        97132   no
borrowing_fee_collateral_amount            1781         1781         1781   no
```

Reproduced on five live positions across both markets; on two of them the
funding and borrowing figures are 0, so it isn't universal.

Three things we'd like to get right:

1. **Are the funding and borrowing amounts position-level accruals that settle
   in full on any decrease, or are they meant to be pro-rated to the closed
   fraction?** Either is defensible — we just don't want to guess and then show
   someone a cost that never gets charged.

2. **Is `collateral_funding_net_amount` included in `collateral_delta`?** The
   arithmetic suggests not: `collateral_delta` halves and quarters exactly, and
   a constant term plus a linear one wouldn't. If the 73,844 credit is paid on
   top, we'd like to say so explicitly rather than have it appear as an
   unexplained difference in the user's balance.

3. **Which field should we show as "you will receive X"** for a partial close?
   We're currently using `collateral_delta`. If the funding credit settles
   separately and in full, that line is understated on a partial close, and
   understating a credit is the direction we'd least like to get wrong.

Happy to send the full quote output for any of these, or a reproduction script.

Separately, and much smaller: `withdraw_storage_credit` and
`close_storage_account` are in the manifest but we don't expose either yet.
Nine of the nineteen accounts holding a `t2:` box currently have zero open
positions and a non-zero `storage_available` — so there's idle escrow sitting
there. Is calling `withdraw_storage_credit` from a plain frontend the intended
path for a user to get that back, or is there something we should know first?
