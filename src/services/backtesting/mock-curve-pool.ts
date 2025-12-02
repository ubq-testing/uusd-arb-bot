import type { CurvePoolState, WalletBalances } from "../../types";
import { PRECISION } from "../../types/config";
import type { OhlcvCandle } from "./backtester";
import type { Address } from "viem";

/**
 * Configuration for the mock pool service
 */
export interface MockPoolConfig {
  /** Pool liquidity in USD (for estimation purposes) */
  poolLiquidityUsd: number;
  /** Mock wallet balances for trade calculations */
  walletBalances: WalletBalances;
  /** Fixed gas price in gwei for consistent backtesting */
  gasPriceGwei: number;
}

const DEFAULT_MOCK_CONFIG: MockPoolConfig = {
  poolLiquidityUsd: 136_000,
  walletBalances: {
    lusd: BigInt(100_000) * PRECISION.WAD,
    uusd: BigInt(100_000) * PRECISION.WAD,
    eth: BigInt(10) * PRECISION.WAD,
  },
  gasPriceGwei: 30,
};

/**
 * Mock implementation of CurvePoolService for backtesting.
 *
 * Instead of making RPC calls, this uses historical candle data
 * to simulate what the pool state would have been at that time.
 */
export class MockCurvePoolService {
  private _currentCandle: OhlcvCandle | null = null;
  private _config: MockPoolConfig;

  constructor(config: Partial<MockPoolConfig> = {}) {
    this._config = { ...DEFAULT_MOCK_CONFIG, ...config };
  }

  /**
   * Set the current candle for simulation
   */
  setCurrentCandle(candle: OhlcvCandle): void {
    this._currentCandle = candle;
  }

  /**
   * Get the current candle
   */
  getCurrentCandle(): OhlcvCandle | null {
    return this._currentCandle;
  }

  /**
   * Get UUSD price from "Curve oracle" (simulated from candle close price)
   * Returns price as 18-decimal bigint
   */
  async getUusdPrice(): Promise<bigint> {
    if (!this._currentCandle) {
      throw new Error("No candle set for mock pool service");
    }
    // Convert the close price (pool ratio) to 18-decimal bigint
    return BigInt(Math.floor(this._currentCandle.close * Number(PRECISION.WAD)));
  }

  /**
   * Convert Curve oracle price (18 decimals) to USD
   */
  priceToUsd(price: bigint): number {
    return Number(price) / Number(PRECISION.WAD);
  }

  /**
   * Get pool balances (estimated from liquidity and current price)
   */
  async getBalances(): Promise<{ lusd: bigint; uusd: bigint }> {
    if (!this._currentCandle) {
      throw new Error("No candle set for mock pool service");
    }

    // Estimate pool balances from total liquidity and current ratio
    const totalLiquidityTokens = this._config.poolLiquidityUsd;
    const ratio = this._currentCandle.close;

    // For a stableswap pool near peg, approximate 50/50 split adjusted by ratio
    // If ratio < 1 (UUSD cheap), there's more UUSD in pool (supply > demand)
    // If ratio > 1 (UUSD expensive), there's less UUSD in pool (demand > supply)
    // Formula: uusdFraction = 0.5 × (2 - ratio) keeps fractions in [0, 1] range for ratio ∈ [0, 2]
    const uusdFraction = 0.5 * (2 - ratio);
    const lusdFraction = 1 - uusdFraction;

    const lusdBalance = BigInt(Math.floor(totalLiquidityTokens * lusdFraction)) * PRECISION.WAD;
    const uusdBalance = BigInt(Math.floor(totalLiquidityTokens * uusdFraction)) * PRECISION.WAD;

    return { lusd: lusdBalance, uusd: uusdBalance };
  }

  /**
   * Get virtual price (mock - assume 1.0 for stableswap)
   */
  async getVirtualPrice(): Promise<bigint> {
    return PRECISION.WAD;
  }

  /**
   * Get complete pool state
   */
  async getPoolState(): Promise<CurvePoolState> {
    const [uusdPrice, balances, virtualPrice] = await Promise.all([this.getUusdPrice(), this.getBalances(), this.getVirtualPrice()]);

    return {
      uusdPrice,
      lusdBalance: balances.lusd,
      uusdBalance: balances.uusd,
      virtualPrice,
    };
  }

  /**
   * Get expected output for swapping LUSD -> UUSD (buying UUSD)
   *
   * Uses simplified StableSwap approximation for backtesting.
   *
   * Formula: output = input × ratio × (1 - tradeSize/poolSize × 0.1)
   *
   * The 0.1 multiplier approximates StableSwap behavior near peg:
   * - A trade of 10% of pool size → ~1% slippage
   * - This is consistent with high-A parameter stablecoin pools
   *
   * NOTE: Only used for backtesting. Live operation uses real get_dy() calls.
   */
  async getLusdToUusdQuote(lusdAmount: bigint): Promise<bigint> {
    if (!this._currentCandle) {
      throw new Error("No candle set for mock pool service");
    }

    const ratio = this._currentCandle.close;
    const amountFloat = Number(lusdAmount) / Number(PRECISION.WAD);
    const poolSize = this._config.poolLiquidityUsd / 2;

    // Slippage increases with trade size (0.1 = 10% of pool → 1% slippage)
    const slippageFactor = 1 - (amountFloat / poolSize) * 0.1;
    const outputAmount = amountFloat * ratio * slippageFactor;

    return BigInt(Math.floor(outputAmount * Number(PRECISION.WAD)));
  }

  /**
   * Get expected output for swapping UUSD -> LUSD (selling UUSD)
   *
   * Same approximation as getLusdToUusdQuote but inverted.
   * See that method for derivation of the 0.1 slippage multiplier.
   */
  async getUusdToLusdQuote(uusdAmount: bigint): Promise<bigint> {
    if (!this._currentCandle) {
      throw new Error("No candle set for mock pool service");
    }

    const ratio = this._currentCandle.close;
    const amountFloat = Number(uusdAmount) / Number(PRECISION.WAD);
    const poolSize = this._config.poolLiquidityUsd / 2;

    const slippageFactor = 1 - (amountFloat / poolSize) * 0.1;
    const outputAmount = (amountFloat / ratio) * slippageFactor;

    return BigInt(Math.floor(outputAmount * Number(PRECISION.WAD)));
  }

  /**
   * Calculate slippage for a given swap
   */
  async calculateSlippage(fromToken: "lusd" | "uusd", amount: bigint): Promise<number> {
    const quote = fromToken === "lusd" ? await this.getLusdToUusdQuote(amount) : await this.getUusdToLusdQuote(amount);

    return 1 - Number(quote) / Number(amount);
  }

  /**
   * Estimate swap gas (fixed for backtesting)
   */
  async estimateSwapGas(_fromToken: "lusd" | "uusd", _amount: bigint, _minAmountOut: bigint): Promise<bigint> {
    // Typical Curve swap gas: ~150k + approval ~50k
    return 200_000n;
  }

  /**
   * Get wallet balances (mock)
   */
  async getWalletBalances(_address?: Address): Promise<WalletBalances> {
    return this._config.walletBalances;
  }

  /**
   * Get current gas price in wei (mock)
   */
  async getGasPrice(): Promise<bigint> {
    return BigInt(Math.floor(this._config.gasPriceGwei * 1e9));
  }

  /**
   * Get the bot's wallet address (mock)
   */
  getWalletAddress(): Address | null {
    return "0x0000000000000000000000000000000000000001" as Address;
  }

  /**
   * Check if wallet is initialized for trading (always true for mock)
   */
  hasWallet(): boolean {
    return true;
  }
}
