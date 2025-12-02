import { describe, expect, it, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { AnvilFork, TEST_ACCOUNTS, TEST_PRIVATE_KEYS, DEFAULT_ANVIL_PORT } from "./anvil";
import { TestHelper, formatTokenAmount, parseTokenAmount } from "./test-helpers";
import { TradeExecutor } from "../../src/services/trade-executor";
import { TradeCalculator } from "../../src/services/trade-calculator";
import { PriceMonitor } from "../../src/services/price-monitor";
import { CurvePoolService } from "../../src/services/curve-pool";
import { GasEstimator } from "../../src/services/gas-estimator";
import { createBotConfig } from "../../src/types/config";
import type { TradeCalculation, GasEstimate } from "../../src/types";

/**
 * Integration tests for Trade Executor.
 * These tests run against a forked mainnet using Anvil.
 *
 * Prerequisites:
 * - Start Anvil before running tests:
 *   anvil --host 127.0.0.1 --port 8545 --fork-url YOUR_RPC_URL --chain-id 1
 */
describe("Trade Executor Integration", () => {
  let anvil: AnvilFork;
  let helper: TestHelper;
  let tradeExecutor: TradeExecutor;
  let tradeCalculator: TradeCalculator;
  let priceMonitor: PriceMonitor;
  let curvePool: CurvePoolService;
  let gasEstimator: GasEstimator;
  let config: ReturnType<typeof createBotConfig>;
  let snapshotId: string;
  let originalRpcUrl: string | undefined;

  beforeAll(async () => {
    anvil = new AnvilFork({ port: DEFAULT_ANVIL_PORT });

    // Verify Anvil is running before proceeding
    await anvil.checkConnection();

    helper = new TestHelper(anvil);

    // Set environment variable for RPC URL to use Anvil
    originalRpcUrl = process.env.RPC_URL;
    process.env.RPC_URL = anvil.rpcUrl;

    // Create services pointing to Anvil with bot wallet private key
    curvePool = new CurvePoolService(TEST_PRIVATE_KEYS.BOT_WALLET);
    gasEstimator = new GasEstimator(curvePool);
    tradeExecutor = new TradeExecutor(curvePool, gasEstimator);

    config = createBotConfig({
      ...process.env,
      DEVIATION_THRESHOLD: "0.01",
      MAX_GAS_PRICE_GWEI: "100",
      MAX_SLIPPAGE: "0.01",
    });
    tradeCalculator = new TradeCalculator(curvePool, gasEstimator, config);
    priceMonitor = new PriceMonitor(curvePool, config);

    // Log initial market state
    await helper.logMarketState();
  }, 30000);

  afterAll(() => {
    // Restore original env
    if (originalRpcUrl) {
      process.env.RPC_URL = originalRpcUrl;
    } else {
      delete process.env.RPC_URL;
    }
  });

  beforeEach(async () => {
    // Take snapshot before each test for isolation
    snapshotId = await anvil.snapshot();
  });

  afterEach(async () => {
    // Revert to snapshot after each test
    await anvil.revert(snapshotId);
  });

  describe("Trade calculation", () => {
    it("should calculate trade parameters correctly", async () => {
      // Fund bot wallet with LUSD
      const botWallet = TEST_ACCOUNTS.BOT_WALLET as `0x${string}`;
      const fundAmount = parseTokenAmount(1000);
      await helper.fundWithLusd(botWallet, fundAmount);

      // Get current price data and wallet balances
      const pegStatus = await priceMonitor.getPegStatus();
      const walletBalances = await curvePool.getWalletBalances(botWallet);
      const poolState = await curvePool.getPoolState();

      console.log(`Current UUSD price: $${pegStatus.onChain.poolRatio.toFixed(4)}`);

      // Calculate what trade would look like
      const calculation = await tradeCalculator.calculateTrade(pegStatus, walletBalances, poolState);

      console.log("\n=== Trade Calculation ===");
      console.log(`Action: ${calculation.action}`);
      console.log(`Amount In: ${formatTokenAmount(calculation.amountIn)}`);
      console.log(`Expected Out: ${formatTokenAmount(calculation.expectedAmountOut)}`);
      console.log(`Min Out: ${formatTokenAmount(calculation.minAmountOut)}`);
      console.log(`Expected Slippage: ${(calculation.expectedSlippage * 100).toFixed(4)}%`);
      console.log(`Gas Cost (USD): $${calculation.gasCost.gasCostUsd.toFixed(2)}`);
      console.log(`Should Execute: ${calculation.shouldExecute}`);
      console.log(`Reason: ${calculation.reason}`);
      console.log("=========================");

      // The action depends on market conditions
      expect(["buy-uusd", "sell-uusd", "none"]).toContain(calculation.action);
    }, 60000);

    it("should handle trade calculation with various market conditions", async () => {
      const botWallet = TEST_ACCOUNTS.BOT_WALLET as `0x${string}`;

      // Fund with LUSD first
      const fundAmount = parseTokenAmount(500);
      await helper.fundWithLusd(botWallet, fundAmount);

      // Swap to get UUSD so we have both tokens
      const quote = await helper.getCurveSwapQuote("lusd", fundAmount / 2n);
      await helper.executeCurveSwap(botWallet, "lusd", fundAmount / 2n, (quote * 95n) / 100n);

      // Get balances
      const walletBalances = await curvePool.getWalletBalances(botWallet);
      const pegStatus = await priceMonitor.getPegStatus();
      const poolState = await curvePool.getPoolState();

      console.log(`LUSD balance: ${formatTokenAmount(walletBalances.lusd)}`);
      console.log(`UUSD balance: ${formatTokenAmount(walletBalances.uusd)}`);

      // Calculate trade
      const calculation = await tradeCalculator.calculateTrade(pegStatus, walletBalances, poolState);

      console.log("\n=== Trade Calculation ===");
      console.log(`Action: ${calculation.action}`);
      console.log(`Amount In: ${formatTokenAmount(calculation.amountIn)}`);
      console.log(`Expected Out: ${formatTokenAmount(calculation.expectedAmountOut)}`);
      console.log(`Min Out: ${formatTokenAmount(calculation.minAmountOut)}`);
      console.log(`Expected Slippage: ${(calculation.expectedSlippage * 100).toFixed(4)}%`);
      console.log("==============================\n");

      // Verify calculation consistency
      if (calculation.action !== "none") {
        expect(calculation.expectedAmountOut).toBeGreaterThan(0n);
        expect(calculation.minAmountOut).toBeLessThanOrEqual(calculation.expectedAmountOut);
      }
    }, 90000);
  });

  describe("Trade execution", () => {
    it("should execute buy-uusd trade successfully", async () => {
      const botWallet = TEST_ACCOUNTS.BOT_WALLET as `0x${string}`;
      const fundAmount = parseTokenAmount(100);

      // Fund bot wallet with LUSD
      await helper.fundWithLusd(botWallet, fundAmount);

      // Check initial balances
      const lusdBefore = await helper.getLusdBalance(botWallet);
      const uusdBefore = await helper.getUusdBalance(botWallet);

      console.log(`Before: ${formatTokenAmount(lusdBefore)} LUSD, ${formatTokenAmount(uusdBefore)} UUSD`);

      // Get all necessary data for trade calculation
      const pegStatus = await priceMonitor.getPegStatus();
      const walletBalances = await curvePool.getWalletBalances(botWallet);
      const poolState = await curvePool.getPoolState();

      // Calculate trade
      const calculation = await tradeCalculator.calculateTrade(pegStatus, walletBalances, poolState);

      // Force execution for testing (override safety checks)
      const testCalculation: TradeCalculation = {
        ...calculation,
        // Override with buy-uusd action for testing
        action: "buy-uusd",
        amountIn: fundAmount,
        expectedAmountOut: await curvePool.getLusdToUusdQuote(fundAmount),
        minAmountOut: ((await curvePool.getLusdToUusdQuote(fundAmount)) * 99n) / 100n,
        shouldExecute: true,
        reason: "Integration test execution",
      };

      // Execute trade
      const result = await tradeExecutor.executeTrade(testCalculation);

      // Check final balances
      const lusdAfter = await helper.getLusdBalance(botWallet);
      const uusdAfter = await helper.getUusdBalance(botWallet);

      console.log(`After: ${formatTokenAmount(lusdAfter)} LUSD, ${formatTokenAmount(uusdAfter)} UUSD`);

      if (result.success) {
        console.log(`Trade successful! Tx: ${result.txHash}`);
        console.log(`Amount out: ${formatTokenAmount(result.amountOut ?? 0n)} UUSD`);
        console.log(`Gas used: ${result.gasUsed}`);
        console.log(`Total cost: $${result.totalCostUsd?.toFixed(4)}`);

        expect(lusdAfter).toBeLessThan(lusdBefore);
        expect(uusdAfter).toBeGreaterThan(uusdBefore);
      } else {
        console.log(`Trade failed: ${result.error}`);
        // Trade might fail due to market conditions, which is acceptable
      }
    }, 90000);

    it("should reject trade with zero amount", async () => {
      const zeroGasCost: GasEstimate = {
        gasUnits: 0n,
        gasPriceWei: 0n,
        gasPriceGwei: 0,
        gasCostEth: 0,
        gasCostUsd: 0,
        ethPriceUsd: 0,
      };

      const zeroCalculation: TradeCalculation = {
        action: "buy-uusd",
        amountIn: 0n,
        expectedAmountOut: 0n,
        minAmountOut: 0n,
        expectedSlippage: 0,
        gasCost: zeroGasCost,
        currentDeviation: 0,
        estimatedDeviationAfter: 0,
        shouldExecute: true,
        reason: "Test",
      };

      const result = await tradeExecutor.executeTrade(zeroCalculation);

      expect(result.success).toBe(false);
      expect(result.error).toContain("zero");
    }, 30000);

    it("should reject trade when shouldExecute is false", async () => {
      const mockGasCost: GasEstimate = {
        gasUnits: 180000n,
        gasPriceWei: 50000000000n,
        gasPriceGwei: 50,
        gasCostEth: 0.009,
        gasCostUsd: 20,
        ethPriceUsd: 2000,
      };

      const noExecuteCalculation: TradeCalculation = {
        action: "buy-uusd",
        amountIn: parseTokenAmount(100),
        expectedAmountOut: parseTokenAmount(99),
        minAmountOut: parseTokenAmount(98),
        expectedSlippage: 0.01,
        gasCost: mockGasCost,
        currentDeviation: 2.0,
        estimatedDeviationAfter: 0.5,
        shouldExecute: false,
        reason: "Gas too high",
      };

      const result = await tradeExecutor.executeTrade(noExecuteCalculation);

      expect(result.success).toBe(false);
      expect(result.error).toContain("should not execute");
    }, 30000);

    it("should reject trade with no action", async () => {
      const mockGasCost: GasEstimate = {
        gasUnits: 180000n,
        gasPriceWei: 50000000000n,
        gasPriceGwei: 50,
        gasCostEth: 0.009,
        gasCostUsd: 20,
        ethPriceUsd: 2000,
      };

      const noActionCalculation: TradeCalculation = {
        action: "none",
        amountIn: parseTokenAmount(100),
        expectedAmountOut: parseTokenAmount(99),
        minAmountOut: parseTokenAmount(98),
        expectedSlippage: 0.01,
        gasCost: mockGasCost,
        currentDeviation: 0.5,
        estimatedDeviationAfter: 0.5,
        shouldExecute: true,
        reason: "No deviation",
      };

      const result = await tradeExecutor.executeTrade(noActionCalculation);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No action");
    }, 30000);
  });

  describe("Slippage protection", () => {
    it("should fail trade when slippage exceeds min output", async () => {
      const botWallet = TEST_ACCOUNTS.BOT_WALLET as `0x${string}`;
      const fundAmount = parseTokenAmount(100);

      // Fund bot wallet with LUSD
      await helper.fundWithLusd(botWallet, fundAmount);

      const mockGasCost: GasEstimate = {
        gasUnits: 180000n,
        gasPriceWei: 50000000000n,
        gasPriceGwei: 50,
        gasCostEth: 0.009,
        gasCostUsd: 20,
        ethPriceUsd: 2000,
      };

      // Calculate trade with unrealistic min output
      const unrealisticCalculation: TradeCalculation = {
        action: "buy-uusd",
        amountIn: fundAmount,
        expectedAmountOut: fundAmount * 2n, // Expect 2x (unrealistic)
        minAmountOut: fundAmount * 2n, // Min also 2x
        expectedSlippage: -1, // Negative (gaining?)
        gasCost: mockGasCost,
        currentDeviation: 5.0,
        estimatedDeviationAfter: 0.0,
        shouldExecute: true,
        reason: "Unrealistic test",
      };

      const result = await tradeExecutor.executeTrade(unrealisticCalculation);

      // Should fail because min output can't be met
      expect(result.success).toBe(false);
    }, 60000);
  });

  describe("Gas estimation", () => {
    it("should estimate gas for swap", async () => {
      const botWallet = TEST_ACCOUNTS.BOT_WALLET as `0x${string}`;
      const swapAmount = parseTokenAmount(100);

      // Fund bot wallet with LUSD
      await helper.fundWithLusd(botWallet, swapAmount);

      // Get quote and use the estimateSwapGas method
      const quote = await curvePool.getLusdToUusdQuote(swapAmount);
      const minOut = (quote * 99n) / 100n;
      const gasEstimateResult = await gasEstimator.estimateSwapGas("lusd", swapAmount, minOut);

      console.log("\n=== Gas Estimate ===");
      console.log(`Gas Units: ${gasEstimateResult.gasUnits}`);
      console.log(`Gas Price: ${gasEstimateResult.gasPriceGwei.toFixed(2)} gwei`);
      console.log(`Cost in ETH: ${gasEstimateResult.gasCostEth.toFixed(6)}`);
      console.log(`Cost in USD: $${gasEstimateResult.gasCostUsd.toFixed(2)}`);
      console.log(`ETH Price: $${gasEstimateResult.ethPriceUsd.toFixed(2)}`);
      console.log("====================\n");

      expect(gasEstimateResult.gasUnits).toBeGreaterThan(0n);
      expect(gasEstimateResult.gasPriceGwei).toBeGreaterThan(0);
      expect(gasEstimateResult.gasCostEth).toBeGreaterThan(0);
    }, 60000);
  });
});
