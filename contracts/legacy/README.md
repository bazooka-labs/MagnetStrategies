# contracts/legacy

Retired contracts from the **MagnetDAO** era — the original quarterly-cycle
governance model, replaced by [UVote](../../vote/OVERVIEW.md).

**Nothing here is part of the live protocol.** The live governance contract is
`contracts/uvote/`, which was separated out of this directory on 2026-10-27 so
that the one running contract is not filed beside three that are not.

| Path | State |
|---|---|
| `voting/voting.py` | Deployed as App `3554779766` and **dormant**. It holds zero $U, so no user funds are in it. `VOTING_APP_ID` exists in `web/src/lib/constants.ts` and is never imported. |
| `governance/governance.py` | Never deployed. |
| `treasury/treasury.py` | Never deployed. |
| `deploy.py` | Deploys `governance` + `treasury`. |
| `deploy_voting.py` | Deploys `voting`. |

Their fate — archive or delete — is an open item in
[org/OVERVIEW.md](../../org/OVERVIEW.md#open-items).

## If you run anything here

Each deploy script imports its contract as a **sibling package**
(`from voting.voting import …`), resolved against the script's own directory.
So a script and the package it imports must stay beside each other; the name of
this directory is irrelevant to them. Run from inside this folder.
