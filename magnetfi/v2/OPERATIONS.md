# MagnetFi v2 — operations

Runbooks. For what the protocol is, see [OVERVIEW.md](./OVERVIEW.md); for the
trust model and the monitoring checklist, [ADMIN.md](./ADMIN.md).

---

## Rotating the oracle bot key

The `authorized_updater` is the only key that can post prices. Since the anchor
band was removed there is no on-chain bound on what it may post, so rotation
speed is the only containment — `set_authorized_updater` is deliberately
immediate and not timelocked.

Executed 2026-10-27. This is the procedure that was followed.

### What changes

Two things: the 25-word phrase stored on the bot host, and one address stored
on the oracle. Nothing else.

### Constraints that set the pace

- **Oracle freshness is 1800s.** Past that, borrowing and all three liquidation
  paths revert. Existing loans are unaffected and **repayment never needs a
  fresh oracle**, so no borrower can be trapped.
- **Price history older than 1800s is discarded** (`MAX_TWAP_AGE`). Reuse the
  same `TWAP_STATE_PATH` and a restart inside that window stays warm; exceed it
  and the bot needs `MIN_TWAP_READINGS` (3) fresh readings at `POLL_INTERVAL`
  (300s) before it will post.
- **Never run two bots against one state file.** Two sharing one corrupts the
  history.

Budget about five minutes for steps 3–6.

### Procedure

1. **Fund the new wallet** — 30+ ALGO. The bot spends ~1.15 ALGO/day in fees
   (4 pools × 288 cycles × 0.001). Confirm it lands.
2. **Replace the phrase.** Start → `environment` → *Edit environment variables
   for your account* → **User variables** (top pane) → `BOT_MNEMONIC` → Edit →
   replace → OK. The running bot is unaffected; it loaded its key at startup.
   **This is the only place the phrase is ever typed.** Not a terminal.
3. **Stop the old bot** — close the `magnetfi-lean` console.
4. **Start the new bot** — run `oracle_bot/start_oracles.cmd`.
5. **Verify before rotating.** The startup line `Oracle bot wallet: <address>`
   must be the newly funded wallet. Rejected-post errors immediately after are
   **expected** — it is not authorized yet, and the bot keeps retrying rather
   than exiting. If the address is wrong, fix step 2 and repeat 4–5; nothing is
   rotated yet so this costs only time.
6. **Authorize it** — `/magnetfi` → Admin → Operations → **Rotate bot key** →
   new address → Set updater. Admin-only, immediate.
7. **Confirm** — within ~5 minutes the bot logs
   `pool_id=… price=… confirmed in round …`, and Admin → Oracle Health shows
   four fresh pools.

### Rollback

Repeat step 6 with the old address and restart the old bot. Keep the old wallet
funded until the new feed has run clean for a few hours.

### Afterwards

Sweep the old wallet. Do not reuse that account — it holds no authority after
step 6, but it is a known-exposed key.

---

## Diagnosing a stale feed

The bot logs the reason on every cycle. Read it before acting.

| Log line | Meaning |
|---|---|
| `CompX price stale (Ns > 3600s)` then `CompX unverified; would raise X→Y — refusing (fail-stale)` | **Not a fault in our stack.** CompX's $U box has stopped updating, so the bot will post flat or a decline but not a raise. Affects `U/tALGO`, `U/USDC`, `U/ALGO`; never `ALGO/USDC`. Self-resolves when CompX returns. See the dependency note in OVERVIEW.md |
| `DIVERGENCE: derived $X vs CompX $Y = Z% > 15%` | Our price and CompX's disagree beyond tolerance |
| `price N below sanity floor M` / `above ceiling` | A configured per-asset bound |
| `assert failed pc=395` | The sender is not the `authorized_updater` — expected between steps 5 and 6 of a rotation, a real problem at any other time |
| `PEX cross-check unavailable: Signature was forged or corrupt` | `PEX_ORACLE_PUBKEY_HEX` is stale against PEX's live signer. Cross-check only; gates nothing |

**A frozen pool is not an emergency.** Borrowing and liquidations revert;
deposits, repayment and closing are unaffected. It clears on the first
successful post.

### Which pools can freeze together

`U/tALGO`, `U/USDC` and `U/ALGO` all cross-check the same CompX $U price box,
so they fail as a group. `ALGO/USDC` carries `compx_check_asset_id: null` and
posts regardless — if it is the only pool updating, suspect CompX first.
