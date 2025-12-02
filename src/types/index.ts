/**
 * Core types for UUSD Peg Maintenance Bot
 *
 * This bot's primary purpose is to maintain the UUSD/LUSD peg at 1:1.
 * Profit is incidental - peg stability is the priority.
 */

/**
 * Recommended stabilization action based on peg deviation
 */
export type StabilizationAction = "buy-uusd" | "sell-uusd" | "none";

/**
 * Severity of peg deviation
 */
export type DeviationSeverity = "none" | "low" | "medium" | "high" | "critical";

/**
 * Price data from multiple sources for integrity verification
 */
export interface PriceData {
  /** UUSD price from Curve oracle (18 decimals) */
  curveOraclePrice: bigint;
  /** UUSD/LUSD pool ratio (1.0 = perfect peg) */
  poolRatio: number;
  /** Price deviation from 1:1 peg as percentage (e.g., -0.02 = 2% below peg) */
  deviationPercent: number;
  /** Timestamp of price fetch */
  timestamp: number;
}

/**
 * GeckoTerminal price data for cross-verification
 */
export interface GeckoTerminalPriceData {
  /** UUSD price from GeckoTerminal */
  priceUsd: number;
  /** 24h volume in USD */
  volume24hUsd: number;
  /** Pool liquidity in USD */
  liquidityUsd: number;
  /** Timestamp of data */
  timestamp: number;
}

/**
 * Combined peg status from all sources
 */
export interface PegStatus {
  /** On-chain price data */
  onChain: PriceData;
  /** GeckoTerminal price data (may be null if unavailable) */
  geckoTerminal: GeckoTerminalPriceData | null;
  /** Recommended action to restore peg */
  recommendedAction: StabilizationAction;
  /** Severity of current deviation */
  severity: DeviationSeverity;
  /** Current gas price in gwei */
  gasPriceGwei: number;
  /** Estimated UUSD amount needed to restore peg */
  uusdToRestorePeg: number;
}

/**
 * Current state of the Curve LUSD/UUSD pool
 */
export interface CurvePoolState {
  /** UUSD price from oracle (18 decimals) */
  uusdPrice: bigint;
  /** LUSD balance in pool (18 decimals) */
  lusdBalance: bigint;
  /** UUSD balance in pool (18 decimals) */
  uusdBalance: bigint;
  /** Pool virtual price (18 decimals) */
  virtualPrice: bigint;
}

/**
 * Gas estimation result
 */
export interface GasEstimate {
  /** Gas units needed for transaction */
  gasUnits: bigint;
  /** Current gas price in wei */
  gasPriceWei: bigint;
  /** Gas price in gwei (human readable) */
  gasPriceGwei: number;
  /** Total gas cost in ETH */
  gasCostEth: number;
  /** Total gas cost in USD */
  gasCostUsd: number;
  /** ETH price used for calculation */
  ethPriceUsd: number;
}

/**
 * Trade calculation result for peg restoration
 */
export interface TradeCalculation {
  /** Direction of trade */
  action: StabilizationAction;
  /** Amount of tokens to trade (18 decimals) */
  amountIn: bigint;
  /** Expected output (18 decimals) */
  expectedAmountOut: bigint;
  /** Minimum output after slippage (18 decimals) */
  minAmountOut: bigint;
  /** Expected slippage percentage */
  expectedSlippage: number;
  /** Gas cost estimate */
  gasCost: GasEstimate;
  /** Current deviation from peg */
  currentDeviation: number;
  /** Estimated deviation after trade (closer to 0 is better) */
  estimatedDeviationAfter: number;
  /** Whether trade should be executed based on threshold */
  shouldExecute: boolean;
  /** Reason for execution decision */
  reason: string;
}

/**
 * Trade execution result
 */
export interface TradeResult {
  /** Whether trade was successful */
  success: boolean;
  /** Transaction hash if executed */
  txHash?: string;
  /** Actual amount received */
  amountOut?: bigint;
  /** Error message if failed */
  error?: string;
  /** Gas used */
  gasUsed?: bigint;
  /** Total cost in USD */
  totalCostUsd?: number;
}

/**
 * Wallet balances
 */
export interface WalletBalances {
  /** LUSD balance (18 decimals) */
  lusd: bigint;
  /** UUSD balance (18 decimals) */
  uusd: bigint;
  /** ETH balance (18 decimals) */
  eth: bigint;
}

/**
 * Complete status report for logging/monitoring
 */
export interface StatusReport {
  /** Timestamp of report */
  timestamp: string;
  /** Current peg status */
  pegStatus: PegStatus;
  /** Wallet balances */
  walletBalances: WalletBalances | null;
  /** Trade calculation (if action recommended) */
  tradeCalculation: TradeCalculation | null;
  /** Trade result (if executed) */
  tradeResult: TradeResult | null;
}
