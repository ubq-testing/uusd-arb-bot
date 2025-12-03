/**
 * Defines the contract for Curve pool service implementations.
 * Both the real CurvePoolService and MockCurvePoolService implement this interface,
 * allowing the backtester to use the same PriceMonitor/TradeCalculator logic.
 */

import type { CurvePoolState, WalletBalances } from "../types";
import type { Address } from "viem";

/**
 * Interface for Curve pool operations
 */
export interface CurvePoolServiceInterface {
  // Price operations
  getUusdPrice(): Promise<bigint>;
  priceToUsd(price: bigint): number;

  // Pool state
  getBalances(): Promise<{ lusd: bigint; uusd: bigint }>;
  getVirtualPrice(): Promise<bigint>;
  getPoolState(): Promise<CurvePoolState>;

  // Quotes
  getLusdToUusdQuote(lusdAmount: bigint): Promise<bigint>;
  getUusdToLusdQuote(uusdAmount: bigint): Promise<bigint>;
  calculateSlippage(fromToken: "lusd" | "uusd", amount: bigint): Promise<number>;

  // Gas estimation
  estimateSwapGas(fromToken: "lusd" | "uusd", amount: bigint, minAmountOut: bigint): Promise<bigint>;
  getGasPrice(): Promise<bigint>;

  // Wallet
  getWalletBalances(address?: Address): Promise<WalletBalances>;
  getWalletAddress(): Address | null;
  hasWallet(): boolean;
}
