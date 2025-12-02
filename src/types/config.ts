import { type Address } from "viem";

/**
 * Contract addresses for UUSD ecosystem on Ethereum mainnet
 */
export const CONTRACTS = {
  /** Curve LUSD/UUSD StableSwapNG Pool */
  CURVE_LUSD_UUSD_POOL: "0xcC68509F9cA0E1ed119EAC7c468EC1b1C42f384F" as Address,

  /** UUSD Token (ERC1967 Proxy) */
  UUSD_TOKEN: "0xb6919ef2ee4afc163bc954c5678e2bb570c2d103" as Address,

  /** LUSD Token (Liquidity USD) */
  LUSD_TOKEN: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0" as Address,
} as const;

/**
 * Curve pool indices for LUSD/UUSD pool
 */
export const CURVE_POOL_INDICES = {
  LUSD: 0,
  UUSD: 1,
} as const;

/**
 * Precision constants
 */
export const PRECISION = {
  /** Standard ERC20 decimals (18) */
  TOKEN_DECIMALS: 18n,

  /** 1e18 for bigint math */
  WAD: 10n ** 18n,
} as const;

/**
 * Default configuration for the peg maintenance bot
 */
export const DEFAULT_CONFIG = {
  /**
   * Peg deviation threshold to trigger action (1% = 0.01)
   * Act if pool ratio is more than 1% away from 1.0
   */
  DEVIATION_THRESHOLD: 0.01,

  /**
   * Maximum gas price in gwei to execute trades
   * Delay execution if gas is too expensive (will retry later)
   */
  MAX_GAS_PRICE_GWEI: 50,

  /**
   * Maximum slippage tolerance for swaps (1% = 0.01)
   */
  MAX_SLIPPAGE: 0.01,

  /**
   * Default pool liquidity in USD (used when live data unavailable)
   */
  DEFAULT_POOL_LIQUIDITY_USD: 136000,

  /**
   * Ubiquity RPC base URL
   */
  RPC_BASE_URL: "https://rpc.ubq.fi",

  /**
   * Ethereum mainnet chain ID
   */
  CHAIN_ID: 1,

  /**
   * Gas units estimate for Curve swap + approval
   */
  CURVE_SWAP_GAS_ESTIMATE: 180_000,

  /**
   * GeckoTerminal network identifier for Ethereum
   */
  GECKOTERMINAL_NETWORK: "eth",

  /**
   * Curve pool fee percentage (0.04%)
   */
  CURVE_FEE_PERCENT: 0.04,
} as const;

/**
 * Bot configuration for peg maintenance
 * Note: Profit is NOT a configuration factor - peg stability is the priority
 */
export interface BotConfig {
  /** Peg deviation threshold to trigger action */
  deviationThreshold: number;
  /** Maximum gas price in gwei (delays execution if exceeded) */
  maxGasPriceGwei: number;
  /** Maximum slippage tolerance (more lenient for peg maintenance) */
  maxSlippage: number;
  /** Whether to execute trades (false = dry run) */
  executeEnabled: boolean;
}

/**
 * Create bot config from environment with defaults
 */
export function createBotConfig(env: NodeJS.ProcessEnv): BotConfig {
  return {
    deviationThreshold: env.DEVIATION_THRESHOLD ? parseFloat(env.DEVIATION_THRESHOLD) : DEFAULT_CONFIG.DEVIATION_THRESHOLD,
    maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI ? parseInt(env.MAX_GAS_PRICE_GWEI) : DEFAULT_CONFIG.MAX_GAS_PRICE_GWEI,
    maxSlippage: env.MAX_SLIPPAGE ? parseFloat(env.MAX_SLIPPAGE) : DEFAULT_CONFIG.MAX_SLIPPAGE,
    executeEnabled: env.EXECUTE_ENABLED === "true",
  };
}

/**
 * Get the RPC URL for a given chain ID.
 * Supports RPC_URL environment variable override for testing with Anvil.
 */
export function getRpcUrl(chainId: number = DEFAULT_CONFIG.CHAIN_ID): string {
  // Allow environment variable override for integration tests
  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }
  return `${DEFAULT_CONFIG.RPC_BASE_URL}/${chainId}`;
}
