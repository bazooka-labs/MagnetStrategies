# Magnet Strategies

Magnet Strategies is an Algorand-native DeFi organization founded in June 2025 with a single long-term objective: to grow the value of the Magnet token ($U) at a rate that consistently outpaces ALGO. The organization pursues yield across multiple Algorand DeFi strategies — strategic liquidity pools, liquid staking, node participation rewards, and stablecoin lending — and reinvests returns into the token's underlying value.

**A Bazooka Labs Product.**

## Live

- **Landing page:** https://magnetstrategies.io
- **DAO app:** https://magnetstrategies.io/dao

## Products

### MagnetDAO
Liquidity governance arm of Magnet Strategies. $U holders vote quarterly on which Algorand projects receive treasury-backed liquidity support. LP fees flow back to the treasury and compound into future cycles.

→ [`magnetdao/`](./magnetdao/OVERVIEW.md)

### Magnet Lending *(in development)*
Overcollateralized lending and borrowing protocol for USDC and $U. Deposit assets to earn yield; borrow against collateral without selling your position.

→ [`lending/`](./lending/OVERVIEW.md)

## Token

| Field        | Value                         |
|--------------|-------------------------------|
| Name         | Magnet                        |
| Ticker       | $U                            |
| ASA ID       | 3081853135                    |
| Total Supply | 750,000 $U                    |
| Decimals     | 5 (1 $U = 100,000 base units) |
| Network      | Algorand mainnet              |
| Founded      | June 2025                     |

## Repository Structure

```
MagnetStrategies/
├── README.md
├── magnetdao/          ← MagnetDAO governance docs
├── lending/            ← Lending protocol architecture docs
├── contracts/
│   ├── magnetdao/      ← Voting contract (live on mainnet)
│   └── lending/        ← Lending contracts (in development)
└── web/                ← Next.js frontend (magnetstrategies.io)
```

## Built by Bazooka Labs

Magnet Strategies is developed and maintained by Bazooka Labs.  
Follow: [X / Twitter](https://x.com/Bazooka_Labs) · [Discord](https://discord.gg/naqFXmfM)
