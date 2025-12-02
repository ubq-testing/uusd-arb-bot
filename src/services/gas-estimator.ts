import type { GasEstimate } from "../types";
import { DEFAULT_CONFIG } from "../types/config";
import type { CurvePoolServiceInterface } from "./interfaces";
import { GeckoTerminalClient } from "./geckoterminal/client";
import { logger } from "../utils/logger";

export class GasEstimator {
  private _curvePool: CurvePoolServiceInterface;
  private _geckoClient: GeckoTerminalClient;
  private _cachedEthPrice: number | null = null;
  private _ethPriceCacheTime = 0;
  private readonly _cacheDurationMs = 60_000; // 1 minute cache

  constructor(curvePool: CurvePoolServiceInterface) {
    this._curvePool = curvePool;
    this._geckoClient = new GeckoTerminalClient();
  }

  /**
   * Get current ETH price in USD with caching
   */
  async getEthPriceUsd(): Promise<number> {
    const now = Date.now();

    // Return cached price if fresh
    if (this._cachedEthPrice && now - this._ethPriceCacheTime < this._cacheDurationMs) {
      return this._cachedEthPrice;
    }

    try {
      this._cachedEthPrice = await this._geckoClient.getEthPriceUsd();
      this._ethPriceCacheTime = now;
      return this._cachedEthPrice;
    } catch (err) {
      logger.warn("Failed to fetch ETH price, using fallback", { err });
      return this._cachedEthPrice ?? 3500; // Fallback
    }
  }

  /**
   * Estimate gas for a swap operation using on-chain simulation
   */
  async estimateSwapGas(fromToken: "lusd" | "uusd", amount: bigint, minAmountOut: bigint): Promise<GasEstimate> {
    // Get current gas price from network
    const gasPriceWei = await this._curvePool.getGasPrice();
    const gasPriceGwei = Number(gasPriceWei) / 1e9;

    // Try to get accurate gas estimate from contract simulation
    let gasUnits: bigint;

    if (this._curvePool.hasWallet()) {
      try {
        gasUnits = await this._curvePool.estimateSwapGas(fromToken, amount, minAmountOut);
        logger.debug("On-chain gas estimation succeeded", { gasUnits: gasUnits.toString() });
      } catch (err) {
        logger.warn("On-chain gas estimation failed, using default", { err });
        gasUnits = BigInt(DEFAULT_CONFIG.CURVE_SWAP_GAS_ESTIMATE);
      }
    } else {
      // No wallet available, use conservative estimate
      gasUnits = BigInt(DEFAULT_CONFIG.CURVE_SWAP_GAS_ESTIMATE);
    }

    // Get ETH price for USD conversion
    const ethPriceUsd = await this.getEthPriceUsd();

    // Calculate gas cost in ETH and USD
    const gasCostWei = gasUnits * gasPriceWei;
    const gasCostEth = Number(gasCostWei) / 1e18;
    const gasCostUsd = gasCostEth * ethPriceUsd;

    logger.info("Gas estimate calculated", {
      gasUnits: gasUnits.toString(),
      gasPriceGwei: gasPriceGwei.toFixed(2),
      gasCostEth: gasCostEth.toFixed(6),
      gasCostUsd: gasCostUsd.toFixed(2),
      ethPriceUsd: ethPriceUsd.toFixed(0),
    });

    return {
      gasUnits,
      gasPriceWei,
      gasPriceGwei,
      gasCostEth,
      gasCostUsd,
      ethPriceUsd,
    };
  }

  /**
   * Check if current gas price is acceptable for trading
   */
  async isGasPriceAcceptable(maxGasPriceGwei: number): Promise<{ acceptable: boolean; currentGwei: number }> {
    const gasPriceWei = await this._curvePool.getGasPrice();
    const currentGwei = Number(gasPriceWei) / 1e9;

    return {
      acceptable: currentGwei <= maxGasPriceGwei,
      currentGwei,
    };
  }
}
