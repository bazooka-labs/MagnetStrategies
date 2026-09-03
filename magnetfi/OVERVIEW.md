# MagnetFi

MagnetFi is the lending and borrowing arm of Magnet Strategies. It gives $U holders and liquidity providers tools to access capital without unwinding their positions — and gives the protocol new revenue streams that compound back into treasury.

MagnetFi is admin-managed. The protocol admin controls rates, liquidations, and reserve levels. There is no governance token at launch; trust is placed in Bazooka Labs as operator.

---

## Products

### v1 — Standard Overcollateralized Lending
Two-pool lending market (USDC Pool + $U Pool). Deposit assets to earn yield; borrow the opposite asset against your collateral. Manual liquidations by admin. Price oracle for $U/USDC.

**Status:** Code complete. Testnet deployment pending.

→ [`v1/`](./v1/OVERVIEW.md)

### v2 — LP Vault + mUSD *(primary focus)*
LP-collateral borrowing protocol with mUSD, an Algorand-native stablecoin. Borrow mUSD against Tinyman LP positions. Interest-only payments with a 4-month grace period. Peg guaranteed by protocol-owned Peg Stability Module.

**Status:** **Live on mainnet** — LP vaults + mUSD + PSMv3 operating on U/tALGO and U/USDC collateral. mUSD ASA `3615600399`.

→ [`v2/`](./v2/OVERVIEW.md)

---

## Architecture Position

```
Magnet Strategies
├── UVote      ← advisory, founder-led governance over $U
└── MagnetFi   ← lending & borrowing
    ├── v1      ← USDC/U two-pool lending (code complete, superseded)
    └── v2      ← LP vault + mUSD stablecoin (LIVE on mainnet)
```

---

## Contracts

| Version | Path | Status |
|---|---|---|
| v1 oracle | `contracts/lending/oracle.py` | Compiled (superseded by v2) |
| v1 pool | `contracts/lending/pool.py` | Compiled (superseded by v2) |
| v2 LP oracle | `magnetfi/v2/contracts/smart_contracts/lp_oracle/` | Built + tested; testnet `765096480` |
| v2 PSM | `magnetfi/v2/contracts/smart_contracts/psm/` | Built + tested; testnet `765096481` |
| v2 vault | `magnetfi/v2/contracts/smart_contracts/vault/` | Built + tested; testnet `765096491` |
| v2 mUSD ASA | mainnet ASA `3615600399` | Live |

---

## Revenue

| Source | Rate | Destination |
|---|---|---|
| v1 borrower interest | 10% protocol fee on interest | Treasury |
| v1 liquidation bonus | 8% of debt in collateral asset | Admin wallet |
| v2 vault loan interest | Per vault type (5–8% APR) | Treasury (admin sweep) |
| v2 PSM redemption fee | 1% on mUSD→USDC only (mint is free) | Treasury (per tx) |
