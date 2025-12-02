/**
 * Handles the execution of trades on the Curve pool.
 * Includes safety checks, transaction monitoring, and result reporting.
 */

import type { TradeCalculation, TradeResult } from "../types";
import { CurvePoolService } from "./curve-pool";
import { GasEstimator } from "./gas-estimator";
import { logger } from "../utils/logger";

export class TradeExecutor {
  private _curvePool: CurvePoolService;
  private _gasEstimator: GasEstimator;

  constructor(curvePool: CurvePoolService, gasEstimator: GasEstimator) {
    this._curvePool = curvePool;
    this._gasEstimator = gasEstimator;
  }

  /**
   * Execute a calculated trade
   */
  async executeTrade(calculation: TradeCalculation): Promise<TradeResult> {
    // Safety check: should not execute
    if (!calculation.shouldExecute) {
      return {
        success: false,
        error: `Trade should not execute: ${calculation.reason}`,
      };
    }

    // Safety check: no action
    if (calculation.action === "none") {
      return {
        success: false,
        error: "No action to execute",
      };
    }

    // Safety check: zero amount
    if (calculation.amountIn === 0n) {
      return {
        success: false,
        error: "Trade amount is zero",
      };
    }

    // Safety check: wallet availability
    if (!this._curvePool.hasWallet()) {
      return {
        success: false,
        error: "Wallet not initialized",
      };
    }

    logger.info("Executing trade", {
      action: calculation.action,
      amountIn: (Number(calculation.amountIn) / 1e18).toFixed(4),
      minAmountOut: (Number(calculation.minAmountOut) / 1e18).toFixed(4),
      expectedSlippage: (calculation.expectedSlippage * 100).toFixed(2) + "%",
    });

    try {
      // Execute the swap
      const result =
        calculation.action === "buy-uusd"
          ? await this._curvePool.swapLusdToUusd(calculation.amountIn, calculation.minAmountOut)
          : await this._curvePool.swapUusdToLusd(calculation.amountIn, calculation.minAmountOut);

      // Calculate actual gas cost
      const ethPrice = await this._gasEstimator.getEthPriceUsd();
      const gasPriceWei = await this._curvePool.getGasPrice();
      const actualGasCostEth = Number(result.gasUsed * gasPriceWei) / 1e18;
      const actualGasCostUsd = actualGasCostEth * ethPrice;

      logger.info("Trade executed successfully", {
        txHash: result.txHash,
        amountIn: (Number(calculation.amountIn) / 1e18).toFixed(4),
        amountOut: (Number(result.amountOut) / 1e18).toFixed(4),
        gasUsed: result.gasUsed.toString(),
        gasCostUsd: actualGasCostUsd.toFixed(2),
      });

      return {
        success: true,
        txHash: result.txHash,
        amountOut: result.amountOut,
        gasUsed: result.gasUsed,
        totalCostUsd: actualGasCostUsd,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error("Trade execution failed", {
        err: errorMessage,
        action: calculation.action,
        amountIn: (Number(calculation.amountIn) / 1e18).toFixed(4),
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Simulate a trade without executing (dry run)
   */
  async simulateTrade(calculation: TradeCalculation): Promise<TradeResult> {
    if (calculation.action === "none") {
      return {
        success: true,
        error: "No action needed - price within threshold",
      };
    }

    if (calculation.amountIn === 0n) {
      return {
        success: false,
        error: "Trade amount is zero",
      };
    }

    // Get fresh quote
    const quote =
      calculation.action === "buy-uusd"
        ? await this._curvePool.getLusdToUusdQuote(calculation.amountIn)
        : await this._curvePool.getUusdToLusdQuote(calculation.amountIn);

    logger.info("Trade simulation complete", {
      action: calculation.action,
      amountIn: (Number(calculation.amountIn) / 1e18).toFixed(4),
      expectedAmountOut: (Number(quote) / 1e18).toFixed(4),
      gasCostUsd: calculation.gasCost.gasCostUsd.toFixed(2),
      currentDeviation: calculation.currentDeviation.toFixed(2) + "%",
      estimatedDeviationAfter: calculation.estimatedDeviationAfter.toFixed(2) + "%",
      wouldExecute: calculation.shouldExecute,
      reason: calculation.reason,
    });

    return {
      success: true,
      amountOut: quote,
      totalCostUsd: calculation.gasCost.gasCostUsd,
    };
  }
}
