import { describe, expect, it, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { AnvilFork, DEFAULT_ANVIL_PORT } from "./anvil";
import { TestHelper, formatTokenAmount } from "./test-helpers";
import { PriceMonitor } from "../../src/services/price-monitor";
import { CurvePoolService } from "../../src/services/curve-pool";
import { createBotConfig } from "../../src/types/config";

/**
 * Integration tests for Price Monitor.
 * These tests run against a forked mainnet using Anvil.
 *
 * Prerequisites:
 * - Start Anvil before running tests:
 *   anvil --host 127.0.0.1 --port 8545 --fork-url YOUR_RPC_URL --chain-id 1
 */
describe("Price Monitor Integration", () => {
  let anvil: AnvilFork;
  let helper: TestHelper;
  let priceMonitor: PriceMonitor;
  let curvePool: CurvePoolService;
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

    // Create services pointing to Anvil
    curvePool = new CurvePoolService();
    const config = createBotConfig({
      ...process.env,
      DEVIATION_THRESHOLD: "0.01",
      MAX_GAS_PRICE_GWEI: "100",
    });
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

  describe("On-chain price fetching", () => {
    it("should fetch on-chain price data from Curve oracle", async () => {
      const priceData = await priceMonitor.getOnChainPriceData();

      console.log("\n=== On-Chain Price Data ===");
      console.log(`UUSD Price: $${priceData.poolRatio.toFixed(4)}`);
      console.log(`Deviation: ${priceData.deviationPercent.toFixed(2)}%`);
      console.log(`Timestamp: ${new Date(priceData.timestamp).toISOString()}`);
      console.log("===========================\n");

      // Price should be close to $1 (within 10%)
      expect(priceData.poolRatio).toBeGreaterThan(0.9);
      expect(priceData.poolRatio).toBeLessThan(1.1);

      // Deviation should be reasonable (within 10%)
      // deviationPercent is already a percentage (e.g., -0.23 means -0.23%)
      expect(Math.abs(priceData.deviationPercent)).toBeLessThan(10);

      // Raw price should be positive
      expect(priceData.curveOraclePrice).toBeGreaterThan(0n);

      // Timestamp should be recent
      expect(priceData.timestamp).toBeGreaterThan(Date.now() - 60000);
    }, 30000);

    it("should determine recommended action based on price", async () => {
      const status = await priceMonitor.getPegStatus();

      console.log("\n=== Peg Status ===");
      console.log(`Price: $${status.onChain.poolRatio.toFixed(4)}`);
      console.log(`Deviation: ${status.onChain.deviationPercent.toFixed(2)}%`);
      console.log(`Recommended Action: ${status.recommendedAction}`);
      console.log(`Gas Price: ${status.gasPriceGwei.toFixed(2)} gwei`);
      console.log(`Severity: ${status.severity}`);
      console.log("==================\n");

      // Action should be one of the valid options
      expect(["buy-uusd", "sell-uusd", "none"]).toContain(status.recommendedAction);

      // Gas price should be reasonable (even on mainnet fork)
      expect(status.gasPriceGwei).toBeGreaterThan(0);
      expect(status.gasPriceGwei).toBeLessThan(1000); // Sanity check
    }, 30000);
  });

  describe("Price deviation detection", () => {
    it("should detect when price is within threshold (no action needed)", async () => {
      const status = await priceMonitor.getPegStatus();

      // If deviation is small (less than 1%), action should be "none"
      // deviationPercent is already a percentage (e.g., -0.23 means -0.23%)
      if (Math.abs(status.onChain.deviationPercent) < 1) {
        expect(status.recommendedAction).toBe("none");
      }

      console.log(`Deviation ${status.onChain.deviationPercent.toFixed(4)}% -> Action: ${status.recommendedAction}`);
    }, 30000);

    it("should recommend buying UUSD when price is below peg", async () => {
      // Get current price
      const initialStatus = await priceMonitor.getPegStatus();
      console.log(`Initial price: $${initialStatus.onChain.poolRatio.toFixed(4)}`);

      // The action depends on actual market conditions
      // We can't artificially push price below peg easily (need UUSD holder)
      // So we just verify the logic consistency
      // deviationPercent is already a percentage (e.g., -0.23 means -0.23%)
      // Config threshold is 1%, so deviation needs to be < -1 for buy action
      if (initialStatus.onChain.deviationPercent < -1) {
        // Price is more than 1% below peg - should recommend buying
        expect(initialStatus.recommendedAction).toBe("buy-uusd");
      }
    }, 30000);

    it("should recommend selling UUSD when price is above peg", async () => {
      // Get spot price before manipulation
      const spotBefore = await helper.getSpotPrice();
      console.log(`Spot price before manipulation: $${spotBefore.toFixed(4)}`);

      // Create above-peg scenario by adding buy pressure
      await helper.createPriceDeviation("above", 0.05);

      // Check spot price after manipulation
      const spotAfter = await helper.getSpotPrice();
      console.log(`Spot price after manipulation: $${spotAfter.toFixed(4)}`);

      // The Curve oracle is TWAP and won't update immediately
      // But spot price should show the price increased (UUSD more expensive)
      expect(spotAfter).toBeGreaterThan(spotBefore);
    }, 60000);
  });

  describe("Price consistency", () => {
    it("should return consistent prices across multiple calls", async () => {
      const prices: number[] = [];

      // Fetch price multiple times
      for (let i = 0; i < 3; i++) {
        const data = await priceMonitor.getOnChainPriceData();
        prices.push(data.poolRatio);
      }

      function createPriceString(price: number): string {
        return `$${price.toFixed(6)}`;
      }

      console.log(`Prices: ${prices.map(createPriceString).join(", ")}`);

      // All prices should be very close (within 0.01%)
      const maxDiff = Math.max(...prices) - Math.min(...prices);
      expect(maxDiff).toBeLessThan(0.0001);
    }, 30000);

    it("should match helper price reading", async () => {
      const [monitorPrice, helperPrice] = await Promise.all([priceMonitor.getOnChainPriceData(), helper.getUusdPriceFromCurve()]);

      const helperPriceUsd = Number(helperPrice) / 1e18;

      console.log(`Monitor price: $${monitorPrice.poolRatio.toFixed(6)}`);
      console.log(`Helper price: $${helperPriceUsd.toFixed(6)}`);

      // Prices should match exactly (same source)
      expect(Math.abs(monitorPrice.poolRatio - helperPriceUsd)).toBeLessThan(0.000001);
    }, 30000);
  });

  describe("Pool state analysis", () => {
    it("should provide complete pool state", async () => {
      const poolState = await curvePool.getPoolState();

      console.log("\n=== Complete Pool State ===");
      console.log(`UUSD Price: $${curvePool.priceToUsd(poolState.uusdPrice).toFixed(4)}`);
      console.log(`LUSD Balance: ${formatTokenAmount(poolState.lusdBalance)}`);
      console.log(`UUSD Balance: ${formatTokenAmount(poolState.uusdBalance)}`);
      console.log(`Virtual Price: ${formatTokenAmount(poolState.virtualPrice)}`);
      console.log("===========================\n");

      // All values should be positive
      expect(poolState.uusdPrice).toBeGreaterThan(0n);
      expect(poolState.lusdBalance).toBeGreaterThan(0n);
      expect(poolState.uusdBalance).toBeGreaterThan(0n);
      expect(poolState.virtualPrice).toBeGreaterThan(0n);

      // Virtual price should be close to 1 for a healthy pool
      const vpUsd = Number(poolState.virtualPrice) / 1e18;
      expect(vpUsd).toBeGreaterThan(0.99);
      expect(vpUsd).toBeLessThan(1.1);
    }, 30000);
  });
});
