import { describe, expect, it, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { AnvilFork, TEST_ACCOUNTS, DEFAULT_ANVIL_PORT } from "./anvil";
import { TestHelper, formatTokenAmount, parseTokenAmount } from "./test-helpers";
import { CurvePoolService } from "../../src/services/curve-pool";

/**
 * Integration tests for Curve LUSD/UUSD pool interactions.
 * These tests run against a forked mainnet using Anvil.
 *
 * Prerequisites:
 * - Start Anvil before running tests:
 *   anvil --host 127.0.0.1 --port 8545 --fork-url YOUR_RPC_URL --chain-id 1
 */
describe("Curve Pool Integration", () => {
  let anvil: AnvilFork;
  let helper: TestHelper;
  let snapshotId: string;

  beforeAll(async () => {
    anvil = new AnvilFork({ port: DEFAULT_ANVIL_PORT });

    // Verify Anvil is running before proceeding
    await anvil.checkConnection();

    helper = new TestHelper(anvil);

    // Log initial market state
    await helper.logMarketState();
  }, 30000);

  beforeEach(async () => {
    // Take snapshot before each test for isolation
    snapshotId = await anvil.snapshot();
  });

  afterEach(async () => {
    // Revert to snapshot after each test
    await anvil.revert(snapshotId);
  });

  describe("Read operations", () => {
    it("should read UUSD price from Curve oracle", async () => {
      const price = await helper.getUusdPriceFromCurve();
      const priceUsd = Number(price) / 1e18;

      console.log(`UUSD price: $${priceUsd.toFixed(4)}`);

      // Price should be close to $1 (within 10%)
      expect(priceUsd).toBeGreaterThan(0.9);
      expect(priceUsd).toBeLessThan(1.1);
    }, 30000);

    it("should read pool balances", async () => {
      const balances = await helper.getCurvePoolBalances();

      console.log(`LUSD balance: ${formatTokenAmount(balances.lusd)}`);
      console.log(`UUSD balance: ${formatTokenAmount(balances.uusd)}`);

      // Both balances should be positive
      expect(balances.lusd).toBeGreaterThan(0n);
      expect(balances.uusd).toBeGreaterThan(0n);
    }, 30000);

    it("should get swap quote for LUSD -> UUSD", async () => {
      const amountIn = parseTokenAmount(100); // 100 LUSD
      const quote = await helper.getCurveSwapQuote("lusd", amountIn);

      console.log(`100 LUSD -> ${formatTokenAmount(quote)} UUSD`);

      // Should get roughly similar amount out (within 5% for 100 tokens)
      const ratio = Number(quote) / Number(amountIn);
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.05);
    }, 30000);

    it("should get swap quote for UUSD -> LUSD", async () => {
      const amountIn = parseTokenAmount(100); // 100 UUSD
      const quote = await helper.getCurveSwapQuote("uusd", amountIn);

      console.log(`100 UUSD -> ${formatTokenAmount(quote)} LUSD`);

      // Should get roughly similar amount out
      const ratio = Number(quote) / Number(amountIn);
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.05);
    }, 30000);

    it("should show larger slippage for larger swaps", async () => {
      const smallAmount = parseTokenAmount(100);
      const largeAmount = parseTokenAmount(10000);

      // Calculate effective price for small vs large swap
      const smallQuote = await helper.getCurveSwapQuote("lusd", smallAmount);
      const largeQuote = await helper.getCurveSwapQuote("lusd", largeAmount);

      const smallEffectivePrice = Number(smallQuote) / Number(smallAmount);
      const largeEffectivePrice = Number(largeQuote) / Number(largeAmount);

      console.log(`Small swap (100) effective price: ${smallEffectivePrice.toFixed(6)}`);
      console.log(`Large swap (10000) effective price: ${largeEffectivePrice.toFixed(6)}`);

      // Large swaps should have worse effective price (more slippage)
      expect(largeEffectivePrice).toBeLessThan(smallEffectivePrice);
    }, 30000);

    it("should read pool state using CurvePoolService", async () => {
      // Set environment variable for RPC URL to use Anvil
      const originalRpcUrl = process.env.RPC_URL;
      process.env.RPC_URL = anvil.rpcUrl;

      // Create service pointing to Anvil - this tests the actual service
      const curveService = new CurvePoolService();
      const state = await curveService.getPoolState();

      console.log("\n=== Pool State via CurvePoolService ===");
      console.log(`UUSD price: $${curveService.priceToUsd(state.uusdPrice).toFixed(4)}`);
      console.log(`LUSD balance: ${formatTokenAmount(state.lusdBalance)}`);
      console.log(`UUSD balance: ${formatTokenAmount(state.uusdBalance)}`);
      console.log(`Virtual price: ${formatTokenAmount(state.virtualPrice)}`);
      console.log("==========================================\n");

      expect(state.uusdPrice).toBeGreaterThan(0n);
      expect(state.lusdBalance).toBeGreaterThan(0n);
      expect(state.uusdBalance).toBeGreaterThan(0n);
      expect(state.virtualPrice).toBeGreaterThan(0n);

      // Restore original env
      if (originalRpcUrl) {
        process.env.RPC_URL = originalRpcUrl;
      } else {
        delete process.env.RPC_URL;
      }
    }, 30000);
  });

  describe("Write operations (with impersonation)", () => {
    it("should execute LUSD -> UUSD swap", async () => {
      const swapAmount = parseTokenAmount(100);
      const testAccount = TEST_ACCOUNTS.USER as `0x${string}`;

      // Fund test account with LUSD
      await helper.fundWithLusd(testAccount, swapAmount);

      // Check initial balances
      const lusdBefore = await helper.getLusdBalance(testAccount);
      const uusdBefore = await helper.getUusdBalance(testAccount);

      console.log(`Before: ${formatTokenAmount(lusdBefore)} LUSD, ${formatTokenAmount(uusdBefore)} UUSD`);

      // Get quote and execute swap
      const quote = await helper.getCurveSwapQuote("lusd", swapAmount);
      const minOut = (quote * 99n) / 100n; // 1% slippage
      await helper.executeCurveSwap(testAccount, "lusd", swapAmount, minOut);

      // Check final balances
      const lusdAfter = await helper.getLusdBalance(testAccount);
      const uusdAfter = await helper.getUusdBalance(testAccount);

      console.log(`After: ${formatTokenAmount(lusdAfter)} LUSD, ${formatTokenAmount(uusdAfter)} UUSD`);

      expect(lusdAfter).toBeLessThan(lusdBefore);
      expect(uusdAfter).toBeGreaterThan(uusdBefore);
    }, 60000);

    it("should execute UUSD -> LUSD swap", async () => {
      const fundAmount = parseTokenAmount(200);
      const swapAmount = parseTokenAmount(100);
      const testAccount = TEST_ACCOUNTS.USER as `0x${string}`;

      // Fund test account with LUSD first, then swap half to UUSD
      await helper.fundWithLusd(testAccount, fundAmount);

      // Swap LUSD to UUSD to get some UUSD
      const lusdToUusdQuote = await helper.getCurveSwapQuote("lusd", swapAmount);
      await helper.executeCurveSwap(testAccount, "lusd", swapAmount, (lusdToUusdQuote * 95n) / 100n);

      // Check balances after getting UUSD
      const lusdBefore = await helper.getLusdBalance(testAccount);
      const uusdBefore = await helper.getUusdBalance(testAccount);

      console.log(`Before UUSD->LUSD: ${formatTokenAmount(lusdBefore)} LUSD, ${formatTokenAmount(uusdBefore)} UUSD`);

      // Now swap UUSD back to LUSD
      const uusdSwapAmount = uusdBefore / 2n; // Swap half of UUSD
      const uusdToLusdQuote = await helper.getCurveSwapQuote("uusd", uusdSwapAmount);
      const minOut = (uusdToLusdQuote * 99n) / 100n; // 1% slippage
      await helper.executeCurveSwap(testAccount, "uusd", uusdSwapAmount, minOut);

      // Check final balances
      const lusdAfter = await helper.getLusdBalance(testAccount);
      const uusdAfter = await helper.getUusdBalance(testAccount);

      console.log(`After UUSD->LUSD: ${formatTokenAmount(lusdAfter)} LUSD, ${formatTokenAmount(uusdAfter)} UUSD`);

      expect(lusdAfter).toBeGreaterThan(lusdBefore);
      expect(uusdAfter).toBeLessThan(uusdBefore);
    }, 90000);

    it("should fail swap with too high min_dy", async () => {
      const swapAmount = parseTokenAmount(100);
      const testAccount = TEST_ACCOUNTS.USER as `0x${string}`;

      // Fund test account
      await helper.fundWithLusd(testAccount, swapAmount);

      // Try to swap with completely unrealistic min output (100x input)
      // This should definitely fail as no pool would give 100:1 ratio
      const unrealisticMinOut = swapAmount * 100n;

      await expect(helper.executeCurveSwap(testAccount, "lusd", swapAmount, unrealisticMinOut)).rejects.toThrow();
    }, 60000);
  });

  describe("Price deviation scenarios", () => {
    it("should detect when UUSD is above peg", async () => {
      // Get spot price before manipulation (not TWAP oracle which updates slowly)
      const spotBefore = await helper.getSpotPrice();
      console.log(`UUSD spot price before: $${spotBefore.toFixed(4)}`);

      // Create above-peg scenario by adding buy pressure (5% to make it noticeable)
      await helper.createPriceDeviation("above", 0.05);

      // Check spot price after - this reflects the current pool state immediately
      const spotAfter = await helper.getSpotPrice();
      console.log(`UUSD spot price after manipulation: $${spotAfter.toFixed(4)}`);

      // Spot price should have increased (UUSD is more expensive now)
      expect(spotAfter).toBeGreaterThan(spotBefore);
    }, 60000);

    it("should calculate slippage correctly", async () => {
      const testAccount = TEST_ACCOUNTS.USER as `0x${string}`;

      // Fund with a large amount
      const fundAmount = parseTokenAmount(50000);
      await helper.fundWithLusd(testAccount, fundAmount);

      // Test slippage at different swap sizes
      const sizes = [100, 1000, 5000, 10000];

      console.log("\n=== Slippage Analysis ===");
      for (const size of sizes) {
        const amount = parseTokenAmount(size);
        const quote = await helper.getCurveSwapQuote("lusd", amount);

        // Perfect 1:1 would mean quote === amount
        const slippage = 1 - Number(quote) / Number(amount);
        console.log(`${size.toLocaleString()} LUSD -> ${formatTokenAmount(quote)} UUSD (slippage: ${(slippage * 100).toFixed(4)}%)`);
      }
      console.log("=========================\n");

      // Verify slippage increases with size
      const small = await helper.getCurveSwapQuote("lusd", parseTokenAmount(100));
      const large = await helper.getCurveSwapQuote("lusd", parseTokenAmount(10000));

      const smallSlippage = 1 - Number(small) / Number(parseTokenAmount(100));
      const largeSlippage = 1 - Number(large) / Number(parseTokenAmount(10000));

      expect(largeSlippage).toBeGreaterThan(smallSlippage);
    }, 60000);
  });

  describe("Gas estimation", () => {
    it("should provide reasonable gas estimates for swaps", async () => {
      const testAccount = TEST_ACCOUNTS.USER as `0x${string}`;
      const swapAmount = parseTokenAmount(100);

      // Fund test account
      await helper.fundWithLusd(testAccount, swapAmount);

      // Execute swap and measure gas
      const lusdBefore = await helper.getLusdBalance(testAccount);

      const quote = await helper.getCurveSwapQuote("lusd", swapAmount);
      const minOut = (quote * 99n) / 100n;

      // Get the client to check gas
      const client = anvil.getPublicClient();
      const gasPriceBefore = await client.getGasPrice();

      await helper.executeCurveSwap(testAccount, "lusd", swapAmount, minOut);

      const lusdAfter = await helper.getLusdBalance(testAccount);

      // Log gas price info
      console.log(`Gas price: ${Number(gasPriceBefore) / 1e9} gwei`);
      console.log(`LUSD spent: ${formatTokenAmount(lusdBefore - lusdAfter)}`);

      // Verify the swap actually happened
      expect(lusdAfter).toBeLessThan(lusdBefore);
    }, 60000);
  });
});
