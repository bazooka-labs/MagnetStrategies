# archive

Finished work, kept rather than deleted.

These documents are **closed**: the work they describe was completed and the
findings fixed. They stay in the repo because a public DeFi protocol showing how
its failure modes were found and remediated is worth more than a tidy tree, and
because they are the record of *why* several defences exist.

**Nothing here is current.** Do not treat an archived document as a statement
about how the system behaves today — check the product's `OVERVIEW.md` and
`SPEC.md` instead.

| Document | What it closed |
|---|---|
| `AUDIT-7-REMEDIATION.md` | Audit 7 findings on the Perps surface. Spec written before the code, per the no-hot-fixes rule. |
| `AUDIT-8-REMEDIATION.md` | Audit 8 findings, same process. |
| `AUDIT-9-REMEDIATION.md` | Audit 9 — five findings, 2026-10-05, all fixed. |

## What belongs here

A document whose work is **done and will not resume**. Specifically not:

- anything still referenced as the authority for current behaviour;
- plans that supersede another document's ordering (`magnetfi/v2/REVAMP_PLAN.md`
  supersedes `TODO.md`, so it is live);
- packages for work that has not happened yet (`magnetfi/v2/AUDIT_HANDOFF.md` is
  for an upcoming v3 audit);
- letters drafted and not yet sent
  (`strategy/perps/CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md`).

All four of those were considered for archiving and rejected on reading them.
Filenames are a poor guide to whether something is finished — `REVAMP_PLAN` and
`AUDIT_HANDOFF` both sound historical and are not.
