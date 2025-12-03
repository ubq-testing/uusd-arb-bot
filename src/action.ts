/**
 * Flow:
 * 1. Validate environment and configuration
 * 2. Check UUSD/LUSD pool ratio against 1:1 peg
 * 3. If ratio deviates beyond threshold:
 *    a. Calculate optimal trade size to restore peg
 *    b. Execute trade to restore peg (profit is incidental)
 * 4. Log complete status report
 */

import { createBotConfig } from "./types/config";
import type { StatusReport, WalletBalances } from "./types";
import { logger } from "./utils/logger";
import { CurvePoolService } from "./services/curve-pool";
import { GasEstimator } from "./services/gas-estimator";
import { PriceMonitor } from "./services/price-monitor";
import { TradeCalculator } from "./services/trade-calculator";
import { TradeExecutor } from "./services/trade-executor";

async function main() {
  const startTime = Date.now();
  logger.info("=== UUSD Peg Maintenance Bot Starting ===");

  // Step 1: Validate environment
  const config = await createBotConfig(process.env);

  logger.info("Configuration loaded", {
    deviationThreshold: (config.deviationThreshold * 100).toFixed(2) + "%",
    maxGasPriceGwei: config.maxGasPriceGwei,
    maxSlippage: (config.maxSlippage * 100).toFixed(2) + "%",
    executeEnabled: config.executeEnabled,
    strategyMode: config.strategyMode,
  });

  // Step 2: Initialize services
  const curvePool = new CurvePoolService(config.privateKey);
  const gasEstimator = new GasEstimator(curvePool);
  const priceMonitor = new PriceMonitor(curvePool, config);
  const tradeCalculator = new TradeCalculator(curvePool, gasEstimator, config);
  const tradeExecutor = new TradeExecutor(curvePool, gasEstimator);

  // Step 3: Get current peg status
  logger.info("Fetching current peg status...");
  const pegStatus = await priceMonitor.getPegStatus();

  logger.info("Peg status retrieved", {
    poolRatio: pegStatus.onChain.poolRatio.toFixed(4),
    deviationPercent: pegStatus.onChain.deviationPercent.toFixed(2) + "%",
    severity: pegStatus.severity,
    strategyMode: config.strategyMode,
    curveSwap: {
      action: pegStatus.curveSwap.action,
      spend: `${pegStatus.curveSwap.amountIn.toFixed(0)} ${pegStatus.curveSwap.tokenIn}`,
    },
    ubiquityPool: {
      action: pegStatus.ubiquityPool.action,
      available: pegStatus.ubiquityPool.available,
      reason: pegStatus.ubiquityPool.reason,
    },
    gasPriceGwei: pegStatus.gasPriceGwei.toFixed(2),
  });

  // Step 4: Get wallet balances
  let walletBalances: WalletBalances | null = null;
  if (curvePool.hasWallet()) {
    const balances = await curvePool.getWalletBalances();
    walletBalances = balances;
    logger.info("Wallet balances", {
      lusd: (Number(balances.lusd) / 1e18).toFixed(2),
      uusd: (Number(balances.uusd) / 1e18).toFixed(2),
      eth: (Number(balances.eth) / 1e18).toFixed(6),
    });
  }

  // Step 5: Calculate trade if action recommended
  let tradeCalculation = null;
  let tradeResult = null;

  if (pegStatus.recommendedAction !== "none" && walletBalances) {
    const poolState = await curvePool.getPoolState();

    logger.info("Pool state", {
      lusdBalance: (Number(poolState.lusdBalance) / 1e18).toFixed(2),
      uusdBalance: (Number(poolState.uusdBalance) / 1e18).toFixed(2),
      virtualPrice: (Number(poolState.virtualPrice) / 1e18).toFixed(6),
    });

    tradeCalculation = await tradeCalculator.calculateTrade(pegStatus, walletBalances, poolState);

    // Step 6: Execute or simulate trade
    if (tradeCalculation.shouldExecute) {
      logger.info("Executing trade...");
      tradeResult = await tradeExecutor.executeTrade(tradeCalculation);
    } else {
      logger.info("Simulating trade (not executing)...");
      tradeResult = await tradeExecutor.simulateTrade(tradeCalculation);
    }
  }

  // Step 7: Generate status report
  const report: StatusReport = {
    timestamp: new Date().toISOString(),
    pegStatus,
    walletBalances,
    tradeCalculation,
    tradeResult,
  };

  // Log summary
  const duration = Date.now() - startTime;
  logger.info("=== UUSD Peg Maintenance Bot Complete ===", {
    durationMs: duration,
    poolRatio: pegStatus.onChain.poolRatio.toFixed(4),
    deviationPercent: pegStatus.onChain.deviationPercent.toFixed(2) + "%",
    actionTaken: tradeCalculation?.shouldExecute ? tradeCalculation.action : "none",
    tradeSuccess: tradeResult?.success ?? null,
    txHash: tradeResult?.txHash ?? null,
  });

  return report;
}

main()
  .then((report) => {
    console.log(
      "\nFinal Report:",
      JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
    );
    process.exit(0);
  })
  .catch((error) => {
    logger.error("Bot execution failed", { error });
    process.exit(1);
  });
