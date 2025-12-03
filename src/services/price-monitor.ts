/**
 * Monitors UUSD/LUSD pool ratio for peg maintenance:
 * 1. Curve pool SPOT PRICE via get_dy (primary - accurate market price)
 * 2. Curve TWAP oracle (secondary - for comparison)
 * 3. GeckoTerminal API (tertiary validation)
 * 4. Ubiquity Pool state (for mint/redeem strategy)
 *
 * Determines recommended stabilization action based on peg deviation.
 * Focus is on maintaining the 1:1 peg, NOT on profit.
 *
 * IMPORTANT: Uses spot price (get_dy) not TWAP oracle for accuracy.
 * The TWAP oracle lags behind actual market conditions.
 */

import type { PegStatus, PriceData, GeckoTerminalPriceData, StabilizationAction, DeviationSeverity, UbiquityPoolRestoration } from "../types";
import { CONTRACTS, DEFAULT_CONFIG, type BotConfig } from "../types/config";
import type { CurvePoolServiceInterface } from "./interfaces";
import { GeckoTerminalClient } from "./geckoterminal/client";
import { UbiquityPoolService, PRICE_THRESHOLDS } from "./ubiquity-pool";
import { logger } from "../utils/logger";

export class PriceMonitor {
  private _curvePool: CurvePoolServiceInterface;
  private _ubiquityPool: UbiquityPoolService;
  private _geckoClient: GeckoTerminalClient;
  private _config: BotConfig;

  constructor(curvePool: CurvePoolServiceInterface, config: BotConfig) {
    this._curvePool = curvePool;
    this._ubiquityPool = new UbiquityPoolService();
    this._geckoClient = new GeckoTerminalClient();
    this._config = config;
  }

  /**
   * Get SPOT price by simulating a 1 token swap via get_dy
   * This is the ACTUAL market price, not the lagging TWAP oracle.
   *
   * UUSD price = how much LUSD you get for 1 UUSD
   * This uses get_dy(1, 0, 1e18) where coin1=UUSD, coin0=LUSD
   */
  async getSpotPrice(): Promise<number> {
    const oneToken = 10n ** 18n;
    const lusdOut = await this._curvePool.getUusdToLusdQuote(oneToken);
    return Number(lusdOut) / Number(oneToken);
  }

  /**
   * Get on-chain price data - now uses SPOT PRICE for accuracy
   */
  async getOnChainPriceData(): Promise<PriceData> {
    const [oraclePrice, spotPrice] = await Promise.all([this._curvePool.getUusdPrice(), this.getSpotPrice()]);

    // Use SPOT price for poolRatio (actual market price), not TWAP oracle
    const poolRatio = spotPrice;
    const deviationPercent = (poolRatio - 1) * 100; // e.g., -0.27 means 0.27% below peg

    return {
      curveOraclePrice: oraclePrice,
      poolRatio,
      deviationPercent,
      timestamp: Date.now(),
    };
  }

  /**
   * Get price data from GeckoTerminal for validation
   */
  async getGeckoTerminalPriceData(): Promise<GeckoTerminalPriceData | null> {
    try {
      const poolData = await this._geckoClient.getPool(DEFAULT_CONFIG.GECKOTERMINAL_NETWORK, CONTRACTS.CURVE_LUSD_UUSD_POOL.toLowerCase());
      const attributes = poolData.data.attributes;

      const priceUsd = this._extractUusdPrice(
        attributes,
        poolData.included as Array<{ type: string; id: string; attributes: { price_usd: string | null; symbol?: string } }>
      );
      const volume24hUsd = attributes.volume_usd.h24 ? parseFloat(attributes.volume_usd.h24) : 0;
      const liquidityUsd = attributes.reserve_in_usd ? parseFloat(attributes.reserve_in_usd) : 0;

      return {
        priceUsd,
        volume24hUsd,
        liquidityUsd,
        timestamp: Date.now(),
      };
    } catch (err) {
      logger.warn("Failed to fetch GeckoTerminal price data", { err });
      return null;
    }
  }

  /**
   * Extract UUSD price from pool attributes or included token data
   */
  private _extractUusdPrice(
    attributes: { base_token_price_usd: string | null; quote_token_price_usd: string | null },
    included?: Array<{ type: string; id: string; attributes: { price_usd: string | null; symbol?: string } }>
  ): number {
    // Try base token price first (usually UUSD in this pool)
    if (attributes.base_token_price_usd) {
      return parseFloat(attributes.base_token_price_usd);
    }

    if (attributes.quote_token_price_usd) {
      return parseFloat(attributes.quote_token_price_usd);
    }

    // Fallback to included token data
    return this._findUusdPriceInIncludedTokens(included);
  }

  /**
   * Find UUSD price from included token data
   */
  private _findUusdPriceInIncludedTokens(included?: Array<{ type: string; id: string; attributes: { price_usd: string | null; symbol?: string } }>): number {
    if (!included) return 0;

    for (const item of included) {
      if (item.type !== "token") continue;

      const isUusdToken = item.id.toLowerCase().includes(CONTRACTS.UUSD_TOKEN.toLowerCase()) || item.attributes.symbol?.toLowerCase() === "uusd";

      if (isUusdToken && item.attributes.price_usd) {
        return parseFloat(item.attributes.price_usd);
      }
    }

    return 0;
  }

  /**
   * Determine severity based on deviation percentage
   */
  private _getSeverity(deviationPercent: number): DeviationSeverity {
    const absDeviation = Math.abs(deviationPercent);
    if (absDeviation < this._config.deviationThreshold * 100) return "none";
    if (absDeviation >= 5) return "critical";
    if (absDeviation >= 3) return "high";
    if (absDeviation >= 2) return "medium";
    return "low";
  }

  /**
   * Calculate the amount needed to restore peg based on pool liquidity
   *
   * CORRECTED FORMULA based on empirical Anvil fork testing:
   * - 80 LUSD moves price by ~0.002%
   * - 5000 LUSD moves price by ~0.14%
   * - 8500 LUSD restores peg from -0.27% deviation
   *
   * Formula: avgPoolLiquidity × absDeviation × stableswapFactor × 100
   *
   * The 0.42 factor was calibrated from actual fork testing:
   * 8500 LUSD to fix 0.27% with ~74k avg liquidity
   * factor = 8500 / (74381 × 0.0027 × 100) ≈ 0.42
   */
  private _estimateAmountToRestorePeg(deviationPercent: number, liquidityUsd: number): number {
    const absDeviation = Math.abs(deviationPercent) / 100;

    // Minimum threshold - don't trade for tiny deviations
    if (absDeviation < 0.0005) return 0;

    const avgLiquidity = liquidityUsd / 2;
    const stableswapFactor = 0.42; // Empirically calibrated from Anvil fork testing
    return Math.ceil(avgLiquidity * absDeviation * stableswapFactor * 100);
  }

  /**
   * Determine recommended action based on peg deviation
   */
  private _determineAction(poolRatio: number, gasPriceGwei: number): StabilizationAction {
    const deviation = Math.abs(poolRatio - 1);

    // Check if deviation exceeds threshold
    if (deviation < this._config.deviationThreshold) {
      logger.info("Peg within threshold, no action needed", {
        poolRatio: poolRatio.toFixed(4),
        deviation: (deviation * 100).toFixed(2) + "%",
        threshold: (this._config.deviationThreshold * 100).toFixed(2) + "%",
      });
      return "none";
    }

    // Gas price check is done at execution time - we still want to signal the deviation
    if (gasPriceGwei > this._config.maxGasPriceGwei) {
      logger.info("Gas price elevated, action may be delayed", {
        gasPriceGwei,
        maxGasPriceGwei: this._config.maxGasPriceGwei,
      });
    }

    // Ratio above 1 means UUSD is expensive relative to LUSD - sell UUSD
    if (poolRatio > 1) {
      logger.info("UUSD above peg, recommending sell-uusd to restore peg", {
        poolRatio: poolRatio.toFixed(4),
        deviation: (deviation * 100).toFixed(2) + "%",
      });
      return "sell-uusd";
    }

    // Ratio below 1 means UUSD is cheap relative to LUSD - buy UUSD
    logger.info("UUSD below peg, recommending buy-uusd to restore peg", {
      poolRatio: poolRatio.toFixed(4),
      deviation: (deviation * 100).toFixed(2) + "%",
    });
    return "buy-uusd";
  }

  /**
   * Analyze Ubiquity Pool arbitrage opportunity
   */
  private async _analyzeUbiquityPool(spotPrice: number): Promise<UbiquityPoolRestoration> {
    try {
      const uusdState = await this._ubiquityPool.getPoolState();
      const uusdPriceUsd = this._ubiquityPool.priceToUsd(uusdState.dollarPriceUsd);

      // Above peg: mint and sell opportunity
      if (spotPrice > 1.0) {
        if (uusdState.canMint) {
          const profitMargin = (spotPrice - 1) * 100;
          return {
            action: "mint-sell",
            available: true,
            profitMarginPercent: profitMargin,
            reason: `Mint UUSD at $1.00, sell at $${spotPrice.toFixed(4)} for ${profitMargin.toFixed(2)}% profit`,
          };
        } else {
          const threshold = Number(PRICE_THRESHOLDS.MINT_THRESHOLD) / 1e6;
          const gap = (threshold - uusdPriceUsd) * 100;
          return {
            action: "mint-sell",
            available: false,
            profitMarginPercent: (spotPrice - 1) * 100,
            reason: `Minting requires price >= $${threshold.toFixed(2)} (current: $${uusdPriceUsd.toFixed(4)}, gap: ${gap.toFixed(2)}%)`,
          };
        }
      }

      // Below peg: buy and redeem opportunity
      if (spotPrice < 1.0) {
        if (uusdState.canRedeem) {
          const profitMargin = (1 / spotPrice - 1) * 100;
          return {
            action: "buy-redeem",
            available: true,
            profitMarginPercent: profitMargin,
            reason: `Buy UUSD at $${spotPrice.toFixed(4)}, redeem at $1.00 for ${profitMargin.toFixed(2)}% profit`,
          };
        } else {
          const threshold = Number(PRICE_THRESHOLDS.REDEEM_THRESHOLD) / 1e6;
          const gap = (uusdPriceUsd - threshold) * 100;
          return {
            action: "buy-redeem",
            available: false,
            profitMarginPercent: (1 / spotPrice - 1) * 100,
            reason: `Redemption requires price <= $${threshold.toFixed(2)} (current: $${uusdPriceUsd.toFixed(4)}, gap: ${gap.toFixed(2)}%)`,
          };
        }
      }

      return {
        action: "none",
        available: false,
        profitMarginPercent: 0,
        reason: "Price at peg, no arbitrage opportunity",
      };
    } catch (err) {
      logger.warn("Failed to analyze Ubiquity Pool", { err });
      return {
        action: "none",
        available: false,
        profitMarginPercent: 0,
        reason: "Failed to fetch Ubiquity Pool state",
      };
    }
  }

  /**
   * Get complete peg status with recommended action
   */
  async getPegStatus(): Promise<PegStatus> {
    // Fetch all data in parallel
    const [onChainData, geckoData, gasPrice] = await Promise.all([this.getOnChainPriceData(), this.getGeckoTerminalPriceData(), this._curvePool.getGasPrice()]);

    const gasPriceGwei = Number(gasPrice) / 1e9;

    this._maybeWarnPriceDiff(onChainData, geckoData);

    const recommendedAction = this._determineAction(onChainData.poolRatio, gasPriceGwei);
    const severity = this._getSeverity(onChainData.deviationPercent);

    // Calculate Curve swap restoration
    const poolLiquidity = geckoData?.liquidityUsd ?? DEFAULT_CONFIG.DEFAULT_POOL_LIQUIDITY_USD;
    const amountNeeded = this._estimateAmountToRestorePeg(onChainData.deviationPercent, poolLiquidity);

    const curveSwap = {
      action: recommendedAction,
      tokenIn: onChainData.poolRatio < 1 ? ("LUSD" as const) : ("UUSD" as const),
      amountIn: amountNeeded,
    };

    // Analyze Ubiquity Pool opportunity
    const ubiquityPool = await this._analyzeUbiquityPool(onChainData.poolRatio);

    return {
      onChain: onChainData,
      geckoTerminal: geckoData,
      recommendedAction,
      severity,
      gasPriceGwei,
      curveSwap,
      ubiquityPool,
    };
  }

  private _maybeWarnPriceDiff(onChainData: PriceData, geckoData: GeckoTerminalPriceData | null): void {
    if (!geckoData || geckoData.priceUsd <= 0) return;
    const priceDiff = Math.abs(onChainData.poolRatio - geckoData.priceUsd);
    if (priceDiff <= 0.05) return;

    logger.warn("Large price discrepancy between on-chain and GeckoTerminal", {
      onChainRatio: onChainData.poolRatio.toFixed(4),
      geckoPrice: geckoData.priceUsd.toFixed(4),
      difference: (priceDiff * 100).toFixed(2) + "%",
    });
  }
}
