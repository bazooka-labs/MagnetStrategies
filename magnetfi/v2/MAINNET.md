# MagnetFi — Mainnet Deployment (LIVE)

**Status: LIVE on Algorand mainnet as of 2026-07-30.** Core protocol deployed, reserve seeded,
oracle bot posting, and a canary borrow completed end-to-end. This is the operational source of
truth for the live deployment — all IDs verified on-chain. (Everything here is public on-chain data.)

## Deployed contracts
| Contract | App ID | Notes |
|---|---|---|
| **LP Oracle** | `3644230020` | posts U/tALGO LP price every ~5 min |
| **PSM (v3 — Productive Reserves)** | `3644230181` | the reserve; `PSMv3`, immutable, 34 methods |
| **Vault** | `3644230459` | collateral / borrow / liquidation |

## Assets
| Asset | ID | |
|---|---|---|
| mUSD | `3615600399` | 6 dp; Pera-verified; the stablecoin |
| USDC | `31566704` | canonical mainnet USDC; the reserve asset |
| U/tALGO LP (pool + LP token) | `3163770927` | Tinyman v2 `TinymanPool2.0 U-TALGO`; the launch collateral |

## Role wallets
| Role | Address | Type / use |
|---|---|---|
| Admin (hot) | `KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A` | routine ops, signs via Pera |
| Guardian (cold) | `TM6NWOLLJZNNUFJNP2NR46BYOBLX3V2A5CQ3LEPTU2TMY3DPJT3KM45SI4` | pause / veto / unpause / recover |
| Treasury | `VM2JLZMKFLE635FXX54MU4TY6JUDIMLNRXOQDZUX3FKUFLS2BPEO2VL7QM` | redemption-fee + (future) yield destination |
| Oracle bot (hot) | `QX7EPGRCJWSM5QRYJAIVZHPTO4H3SCRC6UHJMW4HRNMOZAFOBF2HLZZ5CQ` | low-privilege; posts prices only |

## Parameters (live)
- Vault (U/tALGO `3163770927`): **LTV 6000** / **liq threshold 7500** / **rate 800 bps** / `lpasa` = `3163770927`.
- PSM: **buffer 7000 bps (70% floor)**, per-venue cap 10000, **redeem fee 100 bps (1%)**, reserve_deficit 0.
- Oracle: U/tALGO registered; anchor seeded `613851` (≈$0.6139), ±25% band; ±50% per-post guard.

## Current operational state
- **Reserve:** $1,000 USDC seeded (deliberate small ceiling).
- **Oracle bot:** live, posting ~$0.63 every ~5 min (runs on an operator desktop; **auto-restart /
  redundancy still TODO** — a dead bot stalls borrows/liquidations, fail-safe).
- **Canary:** a $10 mUSD borrow against U/tALGO LP succeeded — full stack proven (oracle → LTV →
  issuance → invariant). Circulating = $10, ceiling = $990, invariant holds. 1 open vault.

## Yield venue — Folks Finance (NOT YET LIVE)
The productive-reserves adapter is built + testnet-validated but **not yet deployed/whitelisted** on
mainnet. Folks v2 USDC pool ids for when it is: pool `971372237`, manager `971350278`, fUSDC
`971384592`. Deploy + init via the admin "Productive Reserves" panel, then `propose_adapter` → 48h →
`confirm_adapter`. See [FOLKS_ADAPTER.md](./FOLKS_ADAPTER.md).

## Pending / roadmap
1. **Repay the canary** — complete the round trip (circulating → ~0).
2. **Folks yield adapter** — deploy + whitelist (48h timelock) → the reserve starts earning.
3. **Oracle bot hardening** — auto-restart (Task Scheduler/systemd) + a redundant second instance +
   freshness alert (AUD-004); move off the operator desktop to a VM.
4. **Monitoring** — oracle freshness, bot uptime, vault health, PSM backing ratio (see ADMIN.md).
5. **Scale + open** — raise the ceiling and open to users as the (informal) code review clears.
6. **External audit + legal counsel** — owner's separate track (see AUDIT_HANDOFF.md).

## Launch-time fixes (for the record)
- **Wrong collateral pool caught pre-borrow:** the wizard was given U/**ALGO** LP (`3617313492`)
  instead of U/**tALGO** (`3163770927`). Fixed by reconfiguring the vault + oracle to `3163770927`
  and `remove_pool` on the stray U/ALGO oracle entry. No funds at risk (0 circulating at the time).
- **Bot wallet format:** the first bot wallet was a Pera *Universal* (24-word BIP39) account, which
  `algosdk` can't sign with. Replaced with a 25-word Algorand hot wallet (`QX7E…`), funded, and
  rotated in via `set_authorized_updater`.
- **`requirements.txt`** listed the import name `algosdk` instead of the pip package
  `py-algorand-sdk` — fixed so clean installs work.

## Verify anytime
Read live state: `curl https://mainnet-idx.algonode.cloud/v2/applications/<appId>` (contracts) or
`.../v2/accounts/<address>` (balances). Oracle freshness = the `lp_ts_` global should be < 30 min
old. Frontend config: `web/src/lib/magnetfi.ts` `DEPLOYMENTS.mainnet`.
