/**
 * GeckoTerminal API Client
 *
 * Simplified client for UUSD price monitoring on the Curve LUSD/UUSD pool.
 * Rate Limit: 30 calls/minute (free tier)
 */

import { logger } from "../../utils/logger";
import type { PoolWithIncluded, OhlcvResponse } from "./types";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const API_VERSION = "20230203";

export interface GeckoTerminalClientConfig {
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
  /** Max retries on failure (default: 3) */
  maxRetries?: number;
}

export class GeckoTerminalClient {
  private _timeout: number;
  private _maxRetries: number;
  private _requestCount = 0;
  private _lastResetTime = Date.now();

  constructor(config: GeckoTerminalClientConfig = {}) {
    this._timeout = config.timeout ?? 10000;
    this._maxRetries = config.maxRetries ?? 3;
  }

  /**
   * Make API request with rate limiting and retry logic
   */
  private async _request<T>(endpoint: string, params: Record<string, unknown> = {}, retryCount = 0): Promise<T> {
    // Ensure rate limit window and capacity
    const now = Date.now();
    if (now - this._lastResetTime >= 60000) {
      this._requestCount = 0;
      this._lastResetTime = now;
    }

    if (this._requestCount >= 30) {
      const waitTime = 60000 - (now - this._lastResetTime);
      throw new Error(`Rate limit exceeded. Wait ${Math.ceil(waitTime / 1000)}s`);
    }

    // Build URL with query params
    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    this._requestCount++;

    // Delegate actual fetch+retry logic to a helper to keep cognitive load down
    return this._doFetch<T>(url.toString(), retryCount);
  }

  private async _doFetch<T>(url: string, retryCount: number): Promise<T> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this._timeout);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: `application/json;version=${API_VERSION}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 429 && retryCount < this._maxRetries) {
          await this._sleep(2000 * (retryCount + 1));
          return this._doFetch<T>(url, retryCount + 1);
        }
        throw new Error(`GeckoTerminal API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (retryCount < this._maxRetries && error instanceof Error) {
        if (error.name === "AbortError" || error.message.includes("fetch")) {
          await this._sleep(1000 * (retryCount + 1));
          return this._doFetch<T>(url, retryCount + 1);
        }
      }
      throw error;
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get pool data by address
   */
  async getPool(network: string, poolAddress: string): Promise<PoolWithIncluded> {
    return this._request<PoolWithIncluded>(`/networks/${network}/pools/${poolAddress}`, { include: "base_token,quote_token" });
  }

  /**
   * Get OHLCV data for a pool
   */
  async getPoolOhlcv(network: string, poolAddress: string, timeframe: "minute" | "hour" | "day" = "hour", limit = 1): Promise<OhlcvResponse> {
    return this._request<OhlcvResponse>(`/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}`, { limit });
  }

  /**
   * Get ETH price from a major ETH/USDC pool (for gas cost calculation)
   */
  async getEthPriceUsd() {
    try {
      // Use Uniswap V3 WETH/USDC 0.05% pool
      const response = await this.getPoolOhlcv("eth", "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "hour", 1);

      if (response.data?.attributes?.ohlcv_list?.[0]) {
        return response.data.attributes.ohlcv_list[0][4]; // close price
      }

      throw logger.error("No OHLCV data found for ETH price");
    } catch (err) {
      throw logger.error("Failed to fetch ETH price from GeckoTerminal", { err });
    }
  }
}
