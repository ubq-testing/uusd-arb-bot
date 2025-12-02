/**
 * Monitors UUSD/LUSD pool ratio for peg maintenance:
 * 1. Curve pool on-chain oracle (primary source)
 * 2. GeckoTerminal API (secondary validation)
 *
 * Determines recommended stabilization action based on peg deviation.
 * Focus is on maintaining the 1:1 peg, NOT on profit.
 */

import type { PegStatus, PriceData, GeckoTerminalPriceData, StabilizationAction, DeviationSeverity } from "../types";
import { CONTRACTS, DEFAULT_CONFIG, type BotConfig } from "../types/config";
import type { CurvePoolServiceInterface } from "./interfaces";
import { GeckoTerminalClient } from "./geckoterminal/client";
import { logger } from "../utils/logger";

export class PriceMonitor {
  private _curvePool: CurvePoolServiceInterface;
  private _geckoClient: GeckoTerminalClient;
  private _config: BotConfig;

  constructor(curvePool: CurvePoolServiceInterface, config: BotConfig) {
    this._curvePool = curvePool;
    this._geckoClient = new GeckoTerminalClient();
    this._config = config;
  }

  /**
   * Get on-chain price data from Curve pool oracle
   */
  async getOnChainPriceData(): Promise<PriceData> {
    const price = await this._curvePool.getUusdPrice();
    const poolRatio = this._curvePool.priceToUsd(price);
    const deviationPercent = (poolRatio - 1) * 100; // e.g., -2.0 means 2% below peg

    return {
      curveOraclePrice: price,
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
   * Estimate UUSD needed to restore peg based on pool liquidity
   *
   * Formula: (poolLiquidity / 2) * deviationPercent * efficiencyFactor
   *
   * The 0.5 efficiency factor accounts for StableSwap's amplification:
   * - Curve pools use an amplification parameter (A) that concentrates liquidity around 1:1
   * - This means ~50% less capital is needed to move price compared to constant-product AMMs
   * - See README.md "StableSwap Algorithm" section for derivation
   */
  private _estimateUusdToRestorePeg(deviationPercent: number, liquidityUsd: number): number {
    const absDeviation = Math.abs(deviationPercent) / 100;
    const singleSideLiquidity = liquidityUsd / 2;
    const curveEfficiencyFactor = 0.5;
    return Math.round(singleSideLiquidity * absDeviation * curveEfficiencyFactor);
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
   * Get complete peg status with recommended action
   */
  async getPegStatus(): Promise<PegStatus> {
    // Fetch all data in parallel
    const [onChainData, geckoData, gasPrice] = await Promise.all([this.getOnChainPriceData(), this.getGeckoTerminalPriceData(), this._curvePool.getGasPrice()]);

    const gasPriceGwei = Number(gasPrice) / 1e9;

    this._maybeWarnPriceDiff(onChainData, geckoData);

    const recommendedAction = this._determineAction(onChainData.poolRatio, gasPriceGwei);
    const severity = this._getSeverity(onChainData.deviationPercent);

    // Estimate UUSD needed to restore peg
    const poolLiquidity = geckoData?.liquidityUsd ?? DEFAULT_CONFIG.DEFAULT_POOL_LIQUIDITY_USD;
    const uusdToRestorePeg = this._estimateUusdToRestorePeg(onChainData.deviationPercent, poolLiquidity);

    return {
      onChain: onChainData,
      geckoTerminal: geckoData,
      recommendedAction,
      severity,
      gasPriceGwei,
      uusdToRestorePeg,
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
