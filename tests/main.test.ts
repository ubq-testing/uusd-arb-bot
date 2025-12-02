/**
 * UUSD Arbitrage Bot Tests
 */

import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { createBotConfig, DEFAULT_CONFIG, CONTRACTS, CURVE_POOL_INDICES, PRECISION } from "../src/types/config";
import type { StabilizationAction } from "../src/types";

describe("Bot Configuration", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("should use default values when no env vars set", () => {
    const config = createBotConfig({});

    expect(config.deviationThreshold).toBe(DEFAULT_CONFIG.DEVIATION_THRESHOLD);
    expect(config.maxGasPriceGwei).toBe(DEFAULT_CONFIG.MAX_GAS_PRICE_GWEI);
    expect(config.maxSlippage).toBe(DEFAULT_CONFIG.MAX_SLIPPAGE);
    expect(config.executeEnabled).toBe(false);
  });

  it("should override defaults with env vars", () => {
    const config = createBotConfig({
      DEVIATION_THRESHOLD: "0.02",
      MAX_GAS_PRICE_GWEI: "100",
      MAX_SLIPPAGE: "0.02",
      EXECUTE_ENABLED: "true",
    });

    expect(config.deviationThreshold).toBe(0.02);
    expect(config.maxGasPriceGwei).toBe(100);
    expect(config.maxSlippage).toBe(0.02);
    expect(config.executeEnabled).toBe(true);
  });
});

describe("Contract Constants", () => {
  it("should have valid contract addresses", () => {
    expect(CONTRACTS.CURVE_LUSD_UUSD_POOL).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(CONTRACTS.UUSD_TOKEN).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(CONTRACTS.LUSD_TOKEN).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("should have correct pool indices", () => {
    expect(CURVE_POOL_INDICES.LUSD).toBe(0);
    expect(CURVE_POOL_INDICES.UUSD).toBe(1);
  });

  it("should have correct precision values", () => {
    expect(PRECISION.TOKEN_DECIMALS).toBe(18n);
    expect(PRECISION.WAD).toBe(10n ** 18n);
  });
});

describe("Price Deviation Logic", () => {
  function determineAction(priceUsd: number, deviationThreshold: number): StabilizationAction {
    const deviation = Math.abs(priceUsd - 1);

    if (deviation < deviationThreshold) {
      return "none";
    }

    if (priceUsd > 1) {
      return "sell-uusd";
    }

    return "buy-uusd";
  }

  it("should recommend no action when price is within threshold", () => {
    expect(determineAction(1.005, 0.01)).toBe("none");
    expect(determineAction(0.995, 0.01)).toBe("none");
    expect(determineAction(1.0, 0.01)).toBe("none");
  });

  it("should recommend sell-uusd when price is above threshold", () => {
    expect(determineAction(1.02, 0.01)).toBe("sell-uusd");
    expect(determineAction(1.05, 0.01)).toBe("sell-uusd");
  });

  it("should recommend buy-uusd when price is below threshold", () => {
    expect(determineAction(0.98, 0.01)).toBe("buy-uusd");
    expect(determineAction(0.95, 0.01)).toBe("buy-uusd");
  });
});

describe("Trade Profitability", () => {
  function isProfitable(tradeValueUsd: number, deviation: number, gasCostUsd: number, dexFeePercent: number, minProfitUsd: number): boolean {
    const valueGained = tradeValueUsd * deviation;
    const dexFeeUsd = tradeValueUsd * (dexFeePercent / 100);
    const expectedProfitUsd = valueGained - gasCostUsd - dexFeeUsd;
    return expectedProfitUsd >= minProfitUsd;
  }

  it("should be profitable when gains exceed costs", () => {
    // $1000 trade, 2% deviation, $5 gas, 0.04% fee, $5 min profit
    expect(isProfitable(1000, 0.02, 5, 0.04, 5)).toBe(true);
    // Expected: $20 gain - $5 gas - $0.40 fee = $14.60 profit
  });

  it("should not be profitable when gas is too high", () => {
    // $1000 trade, 1% deviation, $20 gas, 0.04% fee, $5 min profit
    expect(isProfitable(1000, 0.01, 20, 0.04, 5)).toBe(false);
    // Expected: $10 gain - $20 gas - $0.40 fee = -$10.40 profit
  });

  it("should not be profitable when deviation is too small", () => {
    // $1000 trade, 0.5% deviation, $5 gas, 0.04% fee, $5 min profit
    expect(isProfitable(1000, 0.005, 5, 0.04, 5)).toBe(false);
    // Expected: $5 gain - $5 gas - $0.40 fee = -$0.40 profit
  });
});

describe("Slippage Calculation", () => {
  function calculateSlippage(amountIn: bigint, amountOut: bigint): number {
    return 1 - Number(amountOut) / Number(amountIn);
  }

  function calculateMinOutput(expectedOut: bigint, maxSlippage: number): bigint {
    const slippageFactor = BigInt(Math.floor((1 - maxSlippage) * 1e6));
    return (expectedOut * slippageFactor) / 1_000_000n;
  }

  it("should calculate slippage correctly", () => {
    const amountIn = 1000n * PRECISION.WAD;
    const amountOut = 990n * PRECISION.WAD;

    const slippage = calculateSlippage(amountIn, amountOut);
    expect(slippage).toBeCloseTo(0.01, 4); // 1% slippage
  });

  it("should calculate min output with slippage tolerance", () => {
    const expectedOut = 1000n * PRECISION.WAD;
    const maxSlippage = 0.01; // 1%

    const minOutput = calculateMinOutput(expectedOut, maxSlippage);
    // Should be 99% of expected
    expect(Number(minOutput) / Number(expectedOut)).toBeCloseTo(0.99, 4);
  });
});

describe("Trade Decision Logic", () => {
  interface TradeDecisionParams {
    priceUsd: number;
    deviationThreshold: number;
    gasPriceGwei: number;
    maxGasPriceGwei: number;
    expectedSlippage: number;
    maxSlippage: number;
    expectedProfitUsd: number;
    minProfitUsd: number;
    executeEnabled: boolean;
  }

  function shouldExecute(params: TradeDecisionParams): { execute: boolean; reason: string } {
    const deviation = Math.abs(params.priceUsd - 1);

    if (deviation < params.deviationThreshold) {
      return { execute: false, reason: "Price within threshold" };
    }

    if (params.gasPriceGwei > params.maxGasPriceGwei) {
      return { execute: false, reason: "Gas price too high" };
    }

    if (params.expectedSlippage > params.maxSlippage) {
      return { execute: false, reason: "Slippage too high" };
    }

    if (params.expectedProfitUsd < params.minProfitUsd) {
      return { execute: false, reason: "Insufficient profit" };
    }

    if (!params.executeEnabled) {
      return { execute: false, reason: "Execution disabled" };
    }

    return { execute: true, reason: "Trade profitable" };
  }

  it("should not execute when price is within threshold", () => {
    const result = shouldExecute({
      priceUsd: 1.005,
      deviationThreshold: 0.01,
      gasPriceGwei: 30,
      maxGasPriceGwei: 50,
      expectedSlippage: 0.005,
      maxSlippage: 0.01,
      expectedProfitUsd: 10,
      minProfitUsd: 5,
      executeEnabled: true,
    });

    expect(result.execute).toBe(false);
    expect(result.reason).toContain("threshold");
  });

  it("should not execute when gas is too high", () => {
    const result = shouldExecute({
      priceUsd: 1.02,
      deviationThreshold: 0.01,
      gasPriceGwei: 100,
      maxGasPriceGwei: 50,
      expectedSlippage: 0.005,
      maxSlippage: 0.01,
      expectedProfitUsd: 10,
      minProfitUsd: 5,
      executeEnabled: true,
    });

    expect(result.execute).toBe(false);
    expect(result.reason).toContain("Gas");
  });

  it("should not execute when slippage is too high", () => {
    const result = shouldExecute({
      priceUsd: 1.02,
      deviationThreshold: 0.01,
      gasPriceGwei: 30,
      maxGasPriceGwei: 50,
      expectedSlippage: 0.02,
      maxSlippage: 0.01,
      expectedProfitUsd: 10,
      minProfitUsd: 5,
      executeEnabled: true,
    });

    expect(result.execute).toBe(false);
    expect(result.reason).toContain("Slippage");
  });

  it("should not execute when profit is insufficient", () => {
    const result = shouldExecute({
      priceUsd: 1.02,
      deviationThreshold: 0.01,
      gasPriceGwei: 30,
      maxGasPriceGwei: 50,
      expectedSlippage: 0.005,
      maxSlippage: 0.01,
      expectedProfitUsd: 3,
      minProfitUsd: 5,
      executeEnabled: true,
    });

    expect(result.execute).toBe(false);
    expect(result.reason).toContain("profit");
  });

  it("should not execute when disabled", () => {
    const result = shouldExecute({
      priceUsd: 1.02,
      deviationThreshold: 0.01,
      gasPriceGwei: 30,
      maxGasPriceGwei: 50,
      expectedSlippage: 0.005,
      maxSlippage: 0.01,
      expectedProfitUsd: 10,
      minProfitUsd: 5,
      executeEnabled: false,
    });

    expect(result.execute).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  it("should execute when all conditions are met", () => {
    const result = shouldExecute({
      priceUsd: 1.02,
      deviationThreshold: 0.01,
      gasPriceGwei: 30,
      maxGasPriceGwei: 50,
      expectedSlippage: 0.005,
      maxSlippage: 0.01,
      expectedProfitUsd: 10,
      minProfitUsd: 5,
      executeEnabled: true,
    });

    expect(result.execute).toBe(true);
    expect(result.reason).toContain("profitable");
  });
});

describe("Price Conversion", () => {
  function priceToUsd(oraclePrice: bigint): number {
    return Number(oraclePrice) / Number(PRECISION.WAD);
  }

  function usdToOraclePrice(usd: number): bigint {
    return BigInt(Math.floor(usd * Number(PRECISION.WAD)));
  }

  it("should convert oracle price to USD correctly", () => {
    // $1.00
    expect(priceToUsd(PRECISION.WAD)).toBe(1);

    // $1.02
    expect(priceToUsd(1_020_000_000_000_000_000n)).toBeCloseTo(1.02, 6);

    // $0.98
    expect(priceToUsd(980_000_000_000_000_000n)).toBeCloseTo(0.98, 6);
  });

  it("should convert USD to oracle price correctly", () => {
    expect(usdToOraclePrice(1)).toBe(PRECISION.WAD);
    expect(usdToOraclePrice(1.02)).toBe(1_020_000_000_000_000_000n);
    expect(usdToOraclePrice(0.98)).toBe(980_000_000_000_000_000n);
  });
});
