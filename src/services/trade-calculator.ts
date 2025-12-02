/**
 * Calculates optimal trade sizes to restore the UUSD peg.
 *
 * Key principles:
 * 1. PEG MAINTENANCE IS THE PRIORITY - not profit
 * 2. Calculate the exact amount needed to restore 1:1 peg
 * 3. Execute if deviation exceeds threshold, regardless of profit
 * 4. Respect wallet limits: Don't exceed available balance
 */

import type { TradeCalculation, StabilizationAction, WalletBalances, PegStatus, CurvePoolState } from "../types";
import { PRECISION, type BotConfig } from "../types/config";
import type { CurvePoolServiceInterface } from "./interfaces";
import { GasEstimator } from "./gas-estimator";
import { logger } from "../utils/logger";

export class TradeCalculator {
  private _curvePool: CurvePoolServiceInterface;
  private _gasEstimator: GasEstimator;
  private _config: BotConfig;

  constructor(curvePool: CurvePoolServiceInterface, gasEstimator: GasEstimator, config: BotConfig) {
    this._curvePool = curvePool;
    this._gasEstimator = gasEstimator;
    this._config = config;
  }

  /**
   * Calculate the optimal trade amount to restore peg
   *
   * For a Curve StableSwap pool, the price is determined by the ratio of reserves.
   * To move price from P to 1.0:
   * - If P > 1: Sell UUSD (add UUSD to pool, remove LUSD)
   * - If P < 1: Buy UUSD (add LUSD to pool, remove UUSD)
   *
   * The exact amount is complex due to the StableSwap invariant, but we can
   * use binary search with get_dy quotes to find the optimal amount.
   */
  async calculateOptimalTradeAmount(action: StabilizationAction, poolState: CurvePoolState, walletBalances: WalletBalances): Promise<bigint> {
    if (action === "none") {
      return 0n;
    }

    const currentPrice = this._curvePool.priceToUsd(poolState.uusdPrice);
    const deviation = Math.abs(currentPrice - 1);

    // Use available balance as upper bound
    const maxAmount = action === "buy-uusd" ? walletBalances.lusd : walletBalances.uusd;

    if (maxAmount === 0n) {
      logger.warn("No balance available for trade", { action });
      return 0n;
    }

    // Start with a conservative estimate based on pool size and deviation
    // The idea: to move price by X%, we need roughly X% of the smaller pool side
    const smallerPoolSide = poolState.lusdBalance < poolState.uusdBalance ? poolState.lusdBalance : poolState.uusdBalance;

    // Estimate: deviation * pool_size / adjustment_factor
    // adjustmentFactor = 2: StableSwap's amplification parameter concentrates liquidity
    // around 1:1, requiring ~2x LESS capital than constant-product AMMs to move price.
    // This is derived from Curve's StableSwap invariant - see README.md for full math.
    const adjustmentFactor = 2n;
    let estimatedAmount = (smallerPoolSide * BigInt(Math.floor(deviation * 1e6))) / (1_000_000n * adjustmentFactor);

    // Cap at wallet balance
    if (estimatedAmount > maxAmount) {
      estimatedAmount = maxAmount;
      logger.info("Trade amount capped at wallet balance", {
        estimated: estimatedAmount.toString(),
        maxAvailable: maxAmount.toString(),
      });
    }

    // Ensure minimum meaningful trade (at least 10 tokens)
    const minTrade = 10n * PRECISION.WAD;
    if (estimatedAmount < minTrade) {
      estimatedAmount = minTrade;
    }

    // Use binary search to refine the amount
    // We want to find the amount that brings price closest to $1.00
    const refinedAmount = await this._refineTradeAmount(action, estimatedAmount, maxAmount, poolState);

    logger.info("Optimal trade amount calculated", {
      action,
      currentPrice: currentPrice.toFixed(4),
      deviation: (deviation * 100).toFixed(2) + "%",
      tradeAmount: (Number(refinedAmount) / 1e18).toFixed(2),
    });

    return refinedAmount;
  }

  /**
   * Binary search to find the optimal trade amount
   */
  private async _refineTradeAmount(action: StabilizationAction, initialEstimate: bigint, maxAmount: bigint, poolState: CurvePoolState): Promise<bigint> {
    const currentPrice = this._curvePool.priceToUsd(poolState.uusdPrice);

    // We want to bring price to $1.00
    // For buy-uusd (price < 1): buying UUSD increases UUSD price
    // For sell-uusd (price > 1): selling UUSD decreases UUSD price

    let low = PRECISION.WAD; // 1 token minimum
    let high = maxAmount < initialEstimate * 3n ? maxAmount : initialEstimate * 3n;
    let bestAmount = initialEstimate;
    let bestPriceDiff = Math.abs(currentPrice - 1);

    const iterations = 10; // Binary search iterations

    for (let i = 0; i < iterations; i++) {
      const mid = (low + high) / 2n;
      const { resultingPrice, priceDiff } = await this._evaluateTradeAmount(action, mid, currentPrice, poolState);

      if (priceDiff < bestPriceDiff) {
        bestPriceDiff = priceDiff;
        bestAmount = mid;
      }

      // Adjust search range based on resulting price
      const { newLow, newHigh } = this._adjustSearchRange(action, resultingPrice, low, mid, high);
      low = newLow;
      high = newHigh;
    }

    return bestAmount;
  }

  /**
   * Evaluate a trade amount and return the resulting price and difference from target
   */
  private async _evaluateTradeAmount(
    action: StabilizationAction,
    amount: bigint,
    currentPrice: number,
    poolState: CurvePoolState
  ): Promise<{ resultingPrice: number; priceDiff: number }> {
    const simulatedPriceChange = await this._simulatePriceImpact(action, amount, poolState);
    const resultingPrice = action === "buy-uusd" ? currentPrice + simulatedPriceChange : currentPrice - simulatedPriceChange;
    const priceDiff = Math.abs(resultingPrice - 1);
    return { resultingPrice, priceDiff };
  }

  /**
   * Adjust binary search range based on whether we overshot or undershot the target price
   */
  private _adjustSearchRange(action: StabilizationAction, resultingPrice: number, low: bigint, mid: bigint, high: bigint): { newLow: bigint; newHigh: bigint } {
    const hasOvershot = resultingPrice > 1;

    if (hasOvershot) {
      // Overshot - need smaller trade (for buy) or larger (for sell)
      return action === "buy-uusd" ? { newLow: low, newHigh: mid } : { newLow: mid, newHigh: high };
    }

    // Undershot - need larger trade (for buy) or smaller (for sell)
    return action === "buy-uusd" ? { newLow: mid, newHigh: high } : { newLow: low, newHigh: mid };
  }

  /**
   * Simulate price impact of a trade
   * Returns the expected price change (always positive)
   *
   * IMPORTANT: This is an APPROXIMATION used for binary search refinement only.
   *
   * How it works:
   * 1. Calls get_dy() to get the real quote (on-chain for live, mock for backtest)
   * 2. Uses the quote to estimate slippage
   * 3. Applies an empirical formula to estimate resulting price change
   *
   * The formula (sizeRatio * (1 + slippage * 10)) is NOT derived from Curve's
   * StableSwap invariant - it's an empirical approximation that works reasonably
   * well for stablecoin pools near peg. See README.md "Simulation Limitations".
   *
   * For actual trade execution, the real Curve pool handles price updates and
   * the tx will revert if slippage exceeds our minAmountOut protection.
   */
  private async _simulatePriceImpact(action: StabilizationAction, amount: bigint, poolState: CurvePoolState): Promise<number> {
    // Get quote for the swap (on-chain get_dy() for live, mock for backtest)
    const quote = action === "buy-uusd" ? await this._curvePool.getLusdToUusdQuote(amount) : await this._curvePool.getUusdToLusdQuote(amount);

    // Estimate price impact based on pool reserves changing
    // See README.md "StableSwap Algorithm" section for derivation
    const amountFloat = Number(amount) / 1e18;
    const quoteFloat = Number(quote) / 1e18;
    const poolSize = Number(poolState.lusdBalance + poolState.uusdBalance) / 2 / 1e18;

    // Price impact is proportional to trade size vs pool size, amplified by slippage.
    // The 10x amplification factor is empirically derived from StableSwap behavior:
    // - StableSwap concentrates liquidity around 1:1, so small imbalances cause larger price moves
    // - See README.md "StableSwap Algorithm" section for full derivation
    const slippage = Math.abs(amountFloat - quoteFloat) / amountFloat;
    const sizeRatio = amountFloat / poolSize;

    return sizeRatio * (1 + slippage * 10);
  }

  /**
   * Calculate complete trade details for peg restoration
   *
   * NOTE: Profit is NOT a deciding factor. If peg deviation exceeds threshold,
   * we execute to maintain stability. Profit is incidental.
   */
  async calculateTrade(pegStatus: PegStatus, walletBalances: WalletBalances, poolState: CurvePoolState): Promise<TradeCalculation> {
    const action = pegStatus.recommendedAction;

    // No action needed - peg is within threshold
    if (action === "none") {
      return this._emptyTradeResult("Peg within acceptable threshold", pegStatus);
    }

    // Calculate optimal trade amount to restore peg
    const amountIn = await this.calculateOptimalTradeAmount(action, poolState, walletBalances);

    if (amountIn === 0n) {
      return this._emptyTradeResult("Insufficient balance for peg restoration", pegStatus, action);
    }

    // Get expected output
    const expectedAmountOut = action === "buy-uusd" ? await this._curvePool.getLusdToUusdQuote(amountIn) : await this._curvePool.getUusdToLusdQuote(amountIn);

    // Calculate slippage
    const expectedSlippage = 1 - Number(expectedAmountOut) / Number(amountIn);

    // Calculate minimum output with slippage tolerance
    const slippageFactor = BigInt(Math.floor((1 - this._config.maxSlippage) * 1e6));
    const minAmountOut = (expectedAmountOut * slippageFactor) / 1_000_000n;

    // Estimate gas cost
    const gasCost = await this._gasEstimator.estimateSwapGas(action === "buy-uusd" ? "lusd" : "uusd", amountIn, minAmountOut);

    // Calculate estimated deviation after trade
    const currentDeviation = pegStatus.onChain.deviationPercent;
    const tradeImpact = await this._simulatePriceImpact(action, amountIn, poolState);
    const estimatedDeviationAfter = action === "buy-uusd" ? currentDeviation + tradeImpact * 100 : currentDeviation - tradeImpact * 100;

    // Determine if trade should execute
    const isExecuteEnabled = this._config.executeEnabled;
    const isDeviationExceedsThreshold = Math.abs(currentDeviation) >= this._config.deviationThreshold * 100;
    const isGasPriceAcceptable = pegStatus.gasPriceGwei <= this._config.maxGasPriceGwei;

    const execDecision = this._decideExecution({
      isDeviationExceedsThreshold,
      isGasPriceAcceptable,
      isExecuteEnabled,
      pegStatus,
      currentDeviation,
      action,
      amountIn,
    });
    const shouldExecute = execDecision.shouldExecute;
    const reason = execDecision.reason;

    logger.info("Peg restoration calculation complete", {
      action,
      amountIn: (Number(amountIn) / 1e18).toFixed(2),
      expectedAmountOut: (Number(expectedAmountOut) / 1e18).toFixed(2),
      currentDeviation: currentDeviation.toFixed(2) + "%",
      estimatedDeviationAfter: estimatedDeviationAfter.toFixed(2) + "%",
      gasCostUsd: gasCost.gasCostUsd.toFixed(2),
      shouldExecute,
      reason,
    });

    return {
      action,
      amountIn,
      expectedAmountOut,
      minAmountOut,
      expectedSlippage,
      gasCost,
      currentDeviation,
      estimatedDeviationAfter,
      shouldExecute,
      reason,
    };
  }

  private _emptyTradeResult(reason: string, pegStatus: PegStatus, action: StabilizationAction = "none"): TradeCalculation {
    return {
      action,
      amountIn: 0n,
      expectedAmountOut: 0n,
      minAmountOut: 0n,
      expectedSlippage: 0,
      gasCost: {
        gasUnits: 0n,
        gasPriceWei: 0n,
        gasPriceGwei: 0,
        gasCostEth: 0,
        gasCostUsd: 0,
        ethPriceUsd: 0,
      },
      currentDeviation: pegStatus.onChain.deviationPercent,
      estimatedDeviationAfter: pegStatus.onChain.deviationPercent,
      shouldExecute: false,
      reason,
    };
  }

  private _decideExecution(opts: {
    isDeviationExceedsThreshold: boolean;
    isGasPriceAcceptable: boolean;
    isExecuteEnabled: boolean;
    pegStatus: PegStatus;
    currentDeviation: number;
    action: StabilizationAction;
    amountIn: bigint;
  }): { shouldExecute: boolean; reason: string } {
    const { isDeviationExceedsThreshold, isGasPriceAcceptable, isExecuteEnabled, pegStatus, currentDeviation, action, amountIn } = opts;

    if (!isDeviationExceedsThreshold) {
      return {
        shouldExecute: false,
        reason: `Deviation ${Math.abs(currentDeviation).toFixed(2)}% below threshold ${(this._config.deviationThreshold * 100).toFixed(2)}%`,
      };
    }

    if (!isGasPriceAcceptable) {
      return {
        shouldExecute: false,
        reason: `Gas price ${pegStatus.gasPriceGwei.toFixed(1)} gwei exceeds max ${this._config.maxGasPriceGwei} gwei - will retry later`,
      };
    }

    if (!isExecuteEnabled) {
      return { shouldExecute: false, reason: "Execution disabled (dry run mode)" };
    }

    const amountHuman = (Number(amountIn) / 1e18).toFixed(2);
    return { shouldExecute: true, reason: `Peg restoration: ${action} ${amountHuman} UUSD to restore from ${currentDeviation.toFixed(2)}% deviation` };
  }
}
