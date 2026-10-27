# magnetfi/v2/history

Closed records for MagnetFi v2, kept beside the product rather than in the
repo-root `archive/` because they are dense protocol detail that only makes
sense next to the contracts they describe.

**Nothing in here is current.** These documents are not a statement about how
the protocol behaves today — read [`../OVERVIEW.md`](../OVERVIEW.md) for that.
Each carries a banner saying so, and names what has changed since.

| Document | What it records |
|---|---|
| `LEAN_ORACLE_MIGRATION.md` | The 2026-10-17 swap from the banded oracle to the lean one: the evidence the switch was safe, the migration rehearsal, the price cross-check design, and the two findings that generalise. |
| `V2_DEPLOYMENT_RECORD.md` | How v2 reached mainnet — deployments, canaries reconciled on chain, and the audit findings resolved through Pass 24. |

## Why these were kept rather than deleted

Both contain reasoning that is still load-bearing even though the work is done:

- `confirm_lp_oracle` gates on the **block timestamp**, not on the incoming
  oracle. Once 48h has elapsed it will confirm onto a feed that is arbitrarily
  stale — freezing borrowing *and* liquidations in one transaction. Nothing on
  chain checks this for you.
- Grouped calls go through algokit's simulate path, which **drops the assert
  comment**, so an error-message assertion cannot work there. Causes have to be
  proven by construction — a boundary, or a before/after with one intervening
  change.

Neither belongs in a spec; both would be lost if these files were deleted.
