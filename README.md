# UUSD Arbitrage Bot

A simple, focused bot that maintains the UUSD stablecoin peg through automated market operations on the Curve LUSD/UUSD pool.

## Overview

This bot runs as a GitHub Actions cron job every 6 hours to check the UUSD price and execute stabilizing trades when needed.

### How It Works

1. **Price Monitoring**: Fetches UUSD price from both on-chain Curve oracle and GeckoTerminal API for data integrity
2. **Deviation Detection**: Checks if price deviates beyond configurable threshold (default: 1%)
3. **Trade Calculation**: Calculates optimal trade size to restore peg without over-correcting
4. **Gas Estimation**: Uses on-chain simulation for accurate gas cost estimation
5. **Profitability Check**: Only executes if trade is profitable after all costs
6. **Trade Execution**: Swaps on Curve pool to restore price toward $1.00

### Stabilization Logic

- **UUSD > $1.00**: Sell UUSD for LUSD (increases UUSD supply in pool, decreases price)
- **UUSD < $1.00**: Buy UUSD with LUSD (decreases UUSD supply in pool, increases price)

## Configuration

### Environment Variables

| Variable                 | Required | Default | Description                            |
| ------------------------ | -------- | ------- | -------------------------------------- |
| `HOT_WALLET_PRIVATE_KEY` | ✅       | -       | Private key for the trading wallet     |
| `DEVIATION_THRESHOLD`    | ❌       | `0.01`  | Price deviation threshold (0.01 = 1%)  |
| `MAX_GAS_PRICE_GWEI`     | ❌       | `50`    | Maximum gas price in gwei              |
| `MAX_SLIPPAGE`           | ❌       | `0.01`  | Maximum slippage tolerance (0.01 = 1%) |
| `EXECUTE_ENABLED`        | ❌       | `false` | Set to `true` to enable trading        |

### GitHub Actions Secrets

Set these in your repository settings:

- `HOT_WALLET_PRIVATE_KEY`: Your trading wallet's private key

### GitHub Actions Variables

Set these in your repository settings for runtime configuration:

- `DEVIATION_THRESHOLD`
- `MAX_GAS_PRICE_GWEI`
- `MAX_SLIPPAGE`

## Usage

### Local Development

```bash
# Install dependencies
bun install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# Make sure EXECUTE_ENABLED=false for testing!

# Run in dry-run mode (recommended for testing)
bun run start:dry-run

# Run with execution enabled (use with caution!)
bun start
```

### GitHub Actions

The bot runs automatically every 6 hours via the `peg-maintenance.yml` workflow.

## Architecture

```
src/
├── action.ts              # Main entry point
├── types/
│   ├── config.ts          # Configuration and constants
│   ├── env.ts             # Environment validation
│   └── index.ts           # Core type definitions
├── services/
│   ├── curve-pool.ts      # Curve pool interactions
│   ├── price-monitor.ts   # Price monitoring
│   ├── gas-estimator.ts   # Gas cost estimation
│   ├── trade-calculator.ts # Trade size calculation
│   └── trade-executor.ts  # Trade execution
└── utils/
    └── logger.ts          # Logging utility
```

## Contract Addresses

| Contract             | Address                                      |
| -------------------- | -------------------------------------------- |
| Curve LUSD/UUSD Pool | `0xcC68509F9cA0E1ed119EAC7c468EC1b1C42f384F` |
| UUSD Token           | `0xb6919ef2ee4afc163bc954c5678e2bb570c2d103` |
| LUSD Token           | `0x5f98805A4E8be255a32880FDeC7F6728C6568bA0` |

## StableSwap Algorithm & Constants

This section documents the mathematical derivations behind the constants used in trade calculations.

### Price Data Sources

| Use Case       | Data Source              | Method                                     | Notes                            |
| -------------- | ------------------------ | ------------------------------------------ | -------------------------------- |
| Live Operation | On-chain Curve contracts | `price_oracle()`, `get_dy()`, `exchange()` | Real-time, authoritative data    |
| Backtesting    | GeckoTerminal OHLCV API  | Historical candle data                     | Simulates historical pool states |

**Why OHLCV for backtesting?**

- On-chain calls (`price_oracle()`, `get_dy()`) only return the **current** pool state
- There is no way to query "what was the pool price at block X" without an archive node
- OHLCV data provides historical price movements to simulate bot performance over time
- The OHLCV ratio represents the pool's trading pair ratio (LUSD per UUSD), not USD price

**Why not just use `getPool()` from GeckoTerminal?**

- `getPool()` returns **current** pool state only
- OHLCV provides historical time-series data with open/high/low/close/volume
- Backtesting requires historical data to simulate past market conditions

### Curve StableSwap Overview

Curve uses the **StableSwap invariant**, a hybrid between constant-product (x·y=k) and constant-sum (x+y=k) formulas:

```
A·n^n·∑xᵢ + D = A·D·n^n + D^(n+1) / (n^n·∏xᵢ)
```

Where:

- `A` = Amplification parameter (typically 100-2000 for stablecoin pools)
- `n` = Number of tokens in pool (2 for LUSD/UUSD)
- `D` = Total deposits (in normalized units)
- `xᵢ` = Token balances

The key insight: **Higher A concentrates liquidity around 1:1**, meaning:

1. Trades near peg have minimal slippage
2. Less capital is needed to move price compared to Uniswap-style AMMs
3. Price becomes more sensitive to imbalances as they grow

### Constants Explained

#### `adjustmentFactor = 2` (trade-calculator.ts)

**Purpose**: Initial estimate of UUSD needed to restore peg.

**Derivation**:

- In a constant-product AMM, moving price by X% requires ~X% of pool reserves
- StableSwap's amplification concentrates liquidity, requiring ~50% less capital
- Therefore: `tradeAmount ≈ deviation × poolSize / 2`

**Formula**:

```typescript
estimatedAmount = (smallerPoolSide × deviation) / 2
```

**Example**: 2% depeg in a $100k pool → ~$1,000 trade needed (vs ~$2,000 in Uniswap).

#### `curveEfficiencyFactor = 0.5` (price-monitor.ts)

**Purpose**: Same as above, used for estimating capital requirements in price monitoring.

**Derivation**: Empirically derived from Curve pool behavior. The factor accounts for:

1. StableSwap's concentrated liquidity around peg
2. Reduced price impact for trades near 1:1

#### `slippage × 10` Amplification (trade-calculator.ts)

**Purpose**: Estimate price impact from a simulated trade.

**Derivation**:

```typescript
priceImpact = (tradeSize / poolSize) × (1 + slippage × 10)
```

The `× 10` factor accounts for:

1. **Non-linearity**: StableSwap price curves are steep away from peg
2. **Slippage-to-price correlation**: Higher slippage indicates larger price movement
3. **Empirical fit**: Calibrated against real Curve pool behavior

**Note**: This is used only for binary search refinement. Actual quotes come from on-chain `get_dy()` calls.

### Simulation Limitations

The `simulatePriceImpact()` function in `trade-calculator.ts` is an **approximation** used during binary search to find optimal trade sizes. It has limitations:

1. **Not a real oracle**: The formula is derived empirically, not from Curve's actual math
2. **Binary search only**: Used to narrow down trade size; final execution uses real `get_dy()` quotes
3. **Conservative approach**: Errors in simulation are caught by real on-chain validation before execution

**Why approximate instead of query on-chain for each iteration?**

- Binary search requires 10+ iterations to converge
- Each on-chain `get_dy()` call adds ~100-500ms latency
- The approximation gets us "close enough" for the initial estimate
- Final trade uses real `get_dy()` quote with slippage protection

**Live vs Backtest execution flow:**

```
Live:     get_dy() → simulatePriceImpact() [binary search] → get_dy() → exchange()
          ↑ real                           ↑ approximation    ↑ real    ↑ real

Backtest: MockPool.getLusdToUusdQuote() → simulatePriceImpact() → analysis
          ↑ approximation                  ↑ approximation       (no execution)
```

#### `0.1` Slippage Multiplier (mock-curve-pool.ts)

**Purpose**: Mock pool for backtesting only (not used in live operation).

**Formula**:

```typescript
slippageFactor = 1 - (tradeSize / poolSize) × 0.1
```

**Derivation**:

- Empirically observed from Curve stablecoin pools with A=100-500
- A trade of 10% of pool size → ~1% slippage (0.1 × 0.1 = 0.01)
- A trade of 1% of pool size → ~0.1% slippage
- This linear approximation holds well near peg (±5% deviation)

**Limitation**: This is a simplification. Real StableSwap slippage is non-linear and depends on:

- Amplification parameter (A)
- Current pool imbalance
- Trade direction relative to imbalance

For accurate backtest results, compare against known historical trades.

### Binary Search for Optimal Trade Size

The bot uses binary search with real `get_dy()` quotes to find the exact trade amount:

1. **Initial estimate**: `deviation × poolSize / adjustmentFactor`
2. **Binary search**: 10 iterations testing amounts between 1 token and 3× estimate
3. **Selection criteria**: Amount that brings pool ratio closest to 1.0

This approach uses **real on-chain data** via `get_dy()` rather than approximations for the final trade size.

## Safety Features

1. **Dry Run Mode**: Default behavior simulates trades without execution
2. **Gas Price Limits**: Skips trading when gas exceeds threshold
3. **Profitability Check**: Only trades when profitable after all costs
4. **Slippage Protection**: Transactions revert if slippage exceeds tolerance
5. **Price Validation**: Cross-checks prices between on-chain and API sources

## Testing

```bash
# Run unit tests
bun run test

# Spawn Anvil and to run integration tests against a local fork
bun run test:anvil

# Run integration tests
bun run test:integration
```
