/**
 * Fetches historical OHLCV data from GeckoTerminal and runs the
 * PriceMonitor and TradeCalculator logic against historical data.
 *
 * IMPORTANT: OHLCV Pricing Note
 * ─────────────────────────────
 * The GeckoTerminal OHLCV API returns the pool trading pair ratio, NOT USD prices.
 * For the UUSD/LUSD Curve pool, prices represent "LUSD per 1 UUSD" (the pool ratio).
 *
 * Since LUSD is also a stablecoin (~$1.00), this ratio closely approximates UUSD's
 * USD value, but may differ by ~1-2% when LUSD itself deviates from its peg.
 *
 * For peg maintenance purposes, the pool ratio is actually the more relevant metric,
 * as it determines the arbitrage opportunity within the pool regardless of LUSD's
 * absolute USD price.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { GeckoTerminalClient } from "../geckoterminal/client";
import { MockCurvePoolService, type MockPoolConfig } from "./mock-curve-pool";
import { PriceMonitor } from "../price-monitor";
import { GasEstimator } from "../gas-estimator";
import { TradeCalculator } from "../trade-calculator";
import { StabilizationAction, DeviationSeverity, PegStatus, TradeCalculation } from "../../types/index";
import { createBotConfig, CONTRACTS, DEFAULT_CONFIG, BotConfig } from "../../types/config";

// ============================================================================
// Types
// ============================================================================

export type OhlcvTimeframe = "minute" | "hour" | "day";

export interface BacktestConfig {
  poolAddress: string;
  network: string;
  timeframe: OhlcvTimeframe;
  fromDate: Date;
  toDate: Date;
  deviationThreshold: number;
  maxGasPriceGwei: number;
  maxSlippage: number;
  saveData: boolean;
  loadFile: string | null;
  /** Current LUSD/USD price for reference (fetched at runtime) */
  currentLusdPrice?: number;
}

/**
 * OHLCV candle data from the pool.
 * Note: Prices are in LUSD (quote token), representing the pool ratio "LUSD per 1 UUSD".
 * This is NOT the direct USD price of UUSD.
 */
export interface OhlcvCandle {
  timestamp: number;
  date: Date;
  /** Open price in LUSD per UUSD (pool ratio) */
  open: number;
  /** High price in LUSD per UUSD (pool ratio) */
  high: number;
  /** Low price in LUSD per UUSD (pool ratio) */
  low: number;
  /** Close price in LUSD per UUSD (pool ratio) */
  close: number;
  /** Volume in USD */
  volume: number;
}

/**
 * Signal indicating a peg deviation that requires intervention.
 */
export interface PegRestorationSignal {
  timestamp: number;
  date: Date;
  /** Pool ratio (LUSD per UUSD) */
  poolRatio: number;
  /** Deviation from 1:1 peg as percentage (negative = below peg) */
  deviationPercent: number;
  /** Action needed to restore peg */
  action: StabilizationAction;
  /** Estimated UUSD amount needed to restore peg to 1:1 */
  uusdToRestore: number;
  /** Whether this signal exceeds the configured threshold */
  exceedsThreshold: boolean;
  /** Severity level based on deviation (from real PriceMonitor) */
  severity: DeviationSeverity;
  /** Full peg status from PriceMonitor (same as action.ts would see) */
  pegStatus: PegStatus;
  /** Full trade calculation from TradeCalculator (same as action.ts would compute) */
  tradeCalculation: TradeCalculation | null;
}

export interface BacktestResult {
  config: BacktestConfig;
  dataRange: {
    from: Date;
    to: Date;
    candleCount: number;
  };
  /** Pool liquidity in USD (used for peg restoration calculations) */
  poolLiquidityUsd: number;
  priceStats: {
    min: number;
    max: number;
    mean: number;
    current: number;
    minDate: Date;
    maxDate: Date;
  };
  signals: PegRestorationSignal[];
  summary: {
    /** Total number of periods where deviation exceeded threshold */
    totalSignals: number;
    /** Signals where UUSD was below peg (need to buy UUSD) */
    buyUusdSignals: number;
    /** Signals where UUSD was above peg (need to sell UUSD) */
    sellUusdSignals: number;
    /** Signals that exceeded the configured threshold */
    actionableSignals: number;
    /** Average deviation across all signals */
    avgDeviation: number;
    /** Maximum deviation observed */
    maxDeviation: number;
    /** Total UUSD that would have been needed to restore all depegs */
    totalUusdNeeded: number;
    /** Number of periods where ratio was above 1:1 */
    periodsAbovePeg: number;
    /** Number of periods where ratio was below 1:1 */
    periodsBelowPeg: number;
    /** Breakdown by severity */
    bySeverity: {
      low: number;
      medium: number;
      high: number;
      critical: number;
    };
  };
}

export interface BacktestOptions {
  timeframe?: OhlcvTimeframe;
  fromDate?: string;
  toDate?: string;
  threshold?: number;
  saveData?: boolean;
  loadFile?: string | null;
}

// ============================================================================
// Configuration Builder
// ============================================================================

export function buildBacktestConfig(options: BacktestOptions = {}): BacktestConfig {
  const botConfig = createBotConfig(process.env);

  const now = new Date();
  const defaultFromDate = new Date("2025-01-01");

  return {
    poolAddress: CONTRACTS.CURVE_LUSD_UUSD_POOL.toLowerCase(),
    network: DEFAULT_CONFIG.GECKOTERMINAL_NETWORK,
    timeframe: options.timeframe ?? "day",
    fromDate: options.fromDate ? new Date(options.fromDate) : defaultFromDate,
    toDate: options.toDate ? new Date(options.toDate) : now,
    deviationThreshold: options.threshold ?? botConfig.deviationThreshold,
    maxGasPriceGwei: botConfig.maxGasPriceGwei,
    maxSlippage: botConfig.maxSlippage,
    saveData: options.saveData ?? false,
    loadFile: options.loadFile ?? null,
    currentLusdPrice: undefined, // Will be fetched at runtime
  };
}

// ============================================================================
// Current Pool Price Fetching
// ============================================================================

/**
 * Fetch current pool data including LUSD and UUSD prices in USD.
 * This provides context for understanding the OHLCV ratio data.
 */
export async function fetchCurrentPoolPrices(network: string, poolAddress: string): Promise<{ uusdPriceUsd: number; lusdPriceUsd: number; poolRatio: number }> {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}?include=base_token,quote_token`;

  const response = await fetch(url, {
    headers: { Accept: "application/json;version=20230203" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch pool data: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: {
      attributes: {
        base_token_price_usd: string | null;
        quote_token_price_usd: string | null;
        base_token_price_quote_token: string | null;
      };
    };
  };

  const attrs = data.data.attributes;
  const uusdPriceUsd = parseFloat(attrs.base_token_price_usd || "0");
  const lusdPriceUsd = parseFloat(attrs.quote_token_price_usd || "0");
  const poolRatio = parseFloat(attrs.base_token_price_quote_token || "0");

  return { uusdPriceUsd, lusdPriceUsd, poolRatio };
}

// ============================================================================
// OHLCV Data Fetching
// ============================================================================

interface OhlcvPageResult {
  hasMore: boolean;
  newDataCount: number;
}

function processOhlcvPage(response: { data?: { attributes?: { ohlcv_list?: number[][] } } }, allData: number[][], page: number): OhlcvPageResult {
  const ohlcvList = response.data?.attributes?.ohlcv_list;

  if (!ohlcvList || ohlcvList.length === 0) {
    return { hasMore: false, newDataCount: 0 };
  }

  const existingTimestamps = new Set(allData.map((d) => d[0]));
  const uniqueData = ohlcvList.filter((d) => !existingTimestamps.has(d[0]));

  if (uniqueData.length === 0) {
    return { hasMore: false, newDataCount: 0 };
  }

  allData.push(...uniqueData);
  process.stdout.write(`   Page ${page}: ${allData.length} candles total\r`);
  return { hasMore: true, newDataCount: uniqueData.length };
}

export async function fetchAllOhlcv(
  client: GeckoTerminalClient,
  network: string,
  poolAddress: string,
  timeframe: OhlcvTimeframe,
  maxPages: number = 20
): Promise<{ data: number[][]; meta: unknown }> {
  const allData: number[][] = [];
  let page = 1;
  let hasMore = true;

  console.log(`   Fetching OHLCV data (max ${maxPages} pages)...`);

  while (hasMore && page <= maxPages) {
    try {
      const response = await client.getPoolOhlcv(network, poolAddress, timeframe, 1000);
      const result = processOhlcvPage(response, allData, page);
      hasMore = result.hasMore;
      page++;

      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 2100));
      }
    } catch (error) {
      console.error(`\n   Error fetching page ${page}:`, error);
      hasMore = false;
    }
  }

  console.log(`   Fetched ${allData.length} candles total           `);

  allData.sort((a, b) => a[0] - b[0]);

  return { data: allData, meta: { network, poolAddress, timeframe } };
}

// ============================================================================
// Data Processing
// ============================================================================

export function parseOhlcvData(raw: number[][]): OhlcvCandle[] {
  return raw.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp,
    date: new Date(timestamp * 1000),
    open,
    high,
    low,
    close,
    volume,
  }));
}

export function filterByDateRange(candles: OhlcvCandle[], from: Date, to: Date): OhlcvCandle[] {
  const fromTs = from.getTime();
  const toTs = to.getTime();
  return candles.filter((c) => {
    const ts = c.date.getTime();
    return ts >= fromTs && ts <= toTs;
  });
}

// ============================================================================
// Peg Restoration Analysis
// ============================================================================

/**
 * Analyze a candle using the PriceMonitor and TradeCalculator services.
 */
export async function analyzeCandle(
  candle: OhlcvCandle,
  mockPool: MockCurvePoolService,
  priceMonitor: PriceMonitor,
  tradeCalculator: TradeCalculator
): Promise<PegRestorationSignal | null> {
  // Set the candle as the current pool state
  mockPool.setCurrentCandle(candle);

  // Use the PriceMonitor to get peg status
  const pegStatus = await priceMonitor.getPegStatus();

  if (pegStatus.recommendedAction === "none") {
    return null;
  }

  // Get wallet balances and pool state for trade calculation
  const walletBalances = await mockPool.getWalletBalances();
  const poolState = await mockPool.getPoolState();

  // Use the TradeCalculator
  const tradeCalculation = await tradeCalculator.calculateTrade(pegStatus, walletBalances, poolState);

  return {
    timestamp: candle.timestamp,
    date: candle.date,
    poolRatio: pegStatus.onChain.poolRatio,
    deviationPercent: pegStatus.onChain.deviationPercent,
    action: pegStatus.recommendedAction,
    uusdToRestore: pegStatus.uusdToRestorePeg,
    exceedsThreshold: true,
    severity: pegStatus.severity,
    pegStatus,
    tradeCalculation,
  };
}

/**
 * Run backtest analysis using the services.
 */
export async function runBacktestAnalysis(
  candles: OhlcvCandle[],
  config: BacktestConfig,
  mockPoolConfig: Partial<MockPoolConfig> = {}
): Promise<BacktestResult> {
  // Get pool liquidity from config or default
  const poolLiquidityUsd = mockPoolConfig.poolLiquidityUsd ?? DEFAULT_CONFIG.DEFAULT_POOL_LIQUIDITY_USD;

  // Create the mock pool service with the configured liquidity
  const mockPool = new MockCurvePoolService({
    poolLiquidityUsd,
    gasPriceGwei: config.maxGasPriceGwei,
    ...mockPoolConfig,
  });

  // Create bot config for the services
  const botConfig: BotConfig = {
    deviationThreshold: config.deviationThreshold,
    maxGasPriceGwei: config.maxGasPriceGwei,
    maxSlippage: config.maxSlippage,
    executeEnabled: false, // Backtest mode - never execute
  };

  // Create the services  but with mock pool
  const gasEstimator = new GasEstimator(mockPool);
  const priceMonitor = new PriceMonitor(mockPool, botConfig);
  const tradeCalculator = new TradeCalculator(mockPool, gasEstimator, botConfig);

  const signals: PegRestorationSignal[] = [];
  let processed = 0;

  console.log(`   Analyzing ${candles.length} candles using real services...`);

  for (const candle of candles) {
    const signal = await analyzeCandle(candle, mockPool, priceMonitor, tradeCalculator);
    if (signal) {
      signals.push(signal);
    }
    processed++;
    if (processed % 10 === 0 || processed === candles.length) {
      process.stdout.write(`   Processed ${processed}/${candles.length} candles\r`);
    }
  }
  console.log();

  const prices = candles.map((c) => c.close);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const meanPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  const minCandle = candles.find((c) => c.close === minPrice) ?? candles[0];
  const maxCandle = candles.find((c) => c.close === maxPrice) ?? candles[0];

  const buyUusdSignals = signals.filter((s) => s.action === "buy-uusd");
  const sellUusdSignals = signals.filter((s) => s.action === "sell-uusd");
  const actionableSignals = signals.filter((s) => s.exceedsThreshold);

  const deviations = signals.map((s) => Math.abs(s.deviationPercent));
  const avgDeviation = deviations.length > 0 ? deviations.reduce((a, b) => a + b, 0) / deviations.length : 0;
  const maxDeviation = deviations.length > 0 ? Math.max(...deviations) : 0;

  const totalUusdNeeded = signals.reduce((sum, s) => sum + s.uusdToRestore, 0);

  const periodsAbovePeg = candles.filter((c) => c.close > 1.0).length;
  const periodsBelowPeg = candles.filter((c) => c.close < 1.0).length;

  const bySeverity = {
    low: signals.filter((s) => s.severity === "low").length,
    medium: signals.filter((s) => s.severity === "medium").length,
    high: signals.filter((s) => s.severity === "high").length,
    critical: signals.filter((s) => s.severity === "critical").length,
  };

  return {
    config,
    dataRange: {
      from: candles[0]?.date || config.fromDate,
      to: candles[candles.length - 1]?.date || config.toDate,
      candleCount: candles.length,
    },
    poolLiquidityUsd,
    priceStats: {
      min: minPrice,
      max: maxPrice,
      mean: meanPrice,
      current: candles[candles.length - 1]?.close || 0,
      minDate: minCandle?.date || new Date(),
      maxDate: maxCandle?.date || new Date(),
    },
    signals,
    summary: {
      totalSignals: signals.length,
      buyUusdSignals: buyUusdSignals.length,
      sellUusdSignals: sellUusdSignals.length,
      actionableSignals: actionableSignals.length,
      avgDeviation,
      maxDeviation,
      totalUusdNeeded,
      periodsAbovePeg,
      periodsBelowPeg,
      bySeverity,
    },
  };
}

function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").substring(0, 19);
}

function formatPercent(value: number, decimals: number = 2): string {
  const prefix = value >= 0 ? "+" : "-";
  const absValue = Math.abs(value);
  return `${prefix}${absValue.toFixed(decimals)}%`;
}

/** Format price as pool ratio (not USD) */
function formatRatio(value: number): string {
  return `${value.toFixed(4)} LUSD`;
}

function printConfigSection(config: BacktestConfig, poolLiquidityUsd: number): void {
  console.log("⚙️  CONFIGURATION");
  console.log("─".repeat(60));
  console.log(`  Pool:               ${config.poolAddress}`);
  console.log(`  Network:            ${config.network}`);
  console.log(`  Timeframe:          ${config.timeframe}`);
  console.log(`  Date Range:         ${config.fromDate.toISOString().split("T")[0]} to ${config.toDate.toISOString().split("T")[0]}`);
  console.log(`  Deviation Threshold: ${(config.deviationThreshold * 100).toFixed(2)}%`);
  console.log(`  Max Gas Price:      ${config.maxGasPriceGwei} gwei`);
  console.log(`  Pool Liquidity:     $${poolLiquidityUsd.toLocaleString()}`);
  if (config.currentLusdPrice) {
    console.log(`  Current LUSD/USD:   $${config.currentLusdPrice.toFixed(4)}`);
  }
  console.log();
}

function printPriceStatsSection(priceStats: BacktestResult["priceStats"]): void {
  console.log("💰 POOL RATIO STATISTICS (UUSD priced in LUSD)");
  console.log("─".repeat(60));
  console.log(`  Minimum:            ${formatRatio(priceStats.min)} (${formatDate(priceStats.minDate)})`);
  console.log(`  Maximum:            ${formatRatio(priceStats.max)} (${formatDate(priceStats.maxDate)})`);
  console.log(`  Average:            ${formatRatio(priceStats.mean)}`);
  console.log(`  Current:            ${formatRatio(priceStats.current)}`);
  console.log(`  Range:              ${formatPercent((priceStats.min - 1) * 100)} to ${formatPercent((priceStats.max - 1) * 100)} from 1:1 peg`);
  console.log();
  console.log("  ℹ️  Note: Prices show LUSD per 1 UUSD (pool ratio).");
  console.log("      Peg target is 1.0000 LUSD = 1 UUSD.");
  console.log();
}

function printSignalsSection(signals: PegRestorationSignal[]): void {
  if (signals.length === 0) return;

  const topSignals = [...signals].sort((a, b) => Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent)).slice(0, 20);

  console.log("🔝 TOP 20 PEG DEVIATIONS");
  console.log("─".repeat(110));
  console.log("  " + "Date".padEnd(20) + "Ratio".padEnd(14) + "Deviation".padEnd(12) + "Action".padEnd(12) + "Severity".padEnd(12) + "UUSD to Restore");
  console.log("  " + "─".repeat(105));

  for (const signal of topSignals) {
    console.log(
      "  " +
        formatDate(signal.date).padEnd(20) +
        formatRatio(signal.poolRatio).padEnd(14) +
        formatPercent(signal.deviationPercent).padEnd(12) +
        signal.action.padEnd(12) +
        signal.severity.toUpperCase().padEnd(12) +
        `${signal.uusdToRestore.toLocaleString()} UUSD`
    );
  }
  console.log();

  printNotableDepegs(signals);
}

function printNotableDepegs(signals: PegRestorationSignal[]): void {
  const notableDepegs = signals
    .filter((s) => Math.abs(s.deviationPercent) > 2)
    .sort((a, b) => Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent))
    .slice(0, 10);

  if (notableDepegs.length === 0) return;

  console.log("📉 NOTABLE DEPEGS (deviation > 2% from 1:1)");
  console.log("─".repeat(110));
  for (const signal of notableDepegs) {
    console.log(
      `  ${formatDate(signal.date)}: ${formatRatio(signal.poolRatio)} ` +
        `(${formatPercent(signal.deviationPercent)}) → ${signal.action} ${signal.uusdToRestore.toLocaleString()} UUSD to restore peg`
    );
  }
  console.log();
}

function printAssessmentSection(summary: BacktestResult["summary"]): void {
  console.log("📋 PEG MAINTENANCE ASSESSMENT");
  console.log("─".repeat(60));

  if (summary.totalSignals === 0) {
    console.log("  ✅ No significant depegs during this period!");
    console.log("     The peg remained within the configured threshold.");
    return;
  }

  console.log(`  📊 ${summary.totalSignals} periods required peg intervention`);
  console.log(`  💰 Total UUSD needed: ${summary.totalUusdNeeded.toLocaleString()} UUSD (cumulative)`);

  if (summary.bySeverity.critical > 0) {
    console.log(`  🚨 CRITICAL: ${summary.bySeverity.critical} periods with >5% deviation`);
  }
  if (summary.bySeverity.high > 0) {
    console.log(`  ⚠️  HIGH: ${summary.bySeverity.high} periods with 3-5% deviation`);
  }

  console.log();
  console.log("  This data shows when peg maintenance intervention would have been needed.");
  console.log("  The bot would automatically execute trades to restore the 1:1 peg.");
}

export function printBacktestResults(result: BacktestResult): void {
  const { config, dataRange, priceStats, signals, summary } = result;

  console.log("\n" + "═".repeat(100));
  console.log("  📊 UUSD PEG MAINTENANCE BACKTEST RESULTS");
  console.log("═".repeat(100) + "\n");

  printConfigSection(config, result.poolLiquidityUsd);

  console.log("📅 DATA RANGE");
  console.log("─".repeat(60));
  console.log(`  From:               ${formatDate(dataRange.from)}`);
  console.log(`  To:                 ${formatDate(dataRange.to)}`);
  console.log(`  Candles:            ${dataRange.candleCount.toLocaleString()}`);
  console.log();

  printPriceStatsSection(priceStats);

  const totalPeriods = summary.periodsAbovePeg + summary.periodsBelowPeg;
  const abovePercent = totalPeriods > 0 ? ((summary.periodsAbovePeg / totalPeriods) * 100).toFixed(1) : "0";
  const belowPercent = totalPeriods > 0 ? ((summary.periodsBelowPeg / totalPeriods) * 100).toFixed(1) : "0";

  console.log("📈 PEG DISTRIBUTION");
  console.log("─".repeat(60));
  console.log(`  Above Peg:          ${summary.periodsAbovePeg.toLocaleString()} periods (${abovePercent}%)`);
  console.log(`  Below Peg:          ${summary.periodsBelowPeg.toLocaleString()} periods (${belowPercent}%)`);
  console.log();

  console.log("🎯 PEG RESTORATION SIGNALS");
  console.log("─".repeat(60));
  console.log(`  Total Signals:      ${summary.totalSignals} (periods exceeding ${(config.deviationThreshold * 100).toFixed(1)}% threshold)`);
  console.log(`  Buy-UUSD:           ${summary.buyUusdSignals} (ratio below 1:1)`);
  console.log(`  Sell-UUSD:          ${summary.sellUusdSignals} (ratio above 1:1)`);
  console.log(`  Actionable:         ${summary.actionableSignals}`);
  console.log(`  Avg Deviation:      ${formatPercent(summary.avgDeviation)}`);
  console.log(`  Max Deviation:      ${formatPercent(summary.maxDeviation)}`);
  console.log(`  Total UUSD Needed:  ${summary.totalUusdNeeded.toLocaleString()} UUSD (cumulative to restore all depegs)`);
  console.log();

  console.log("📊 SEVERITY BREAKDOWN");
  console.log("─".repeat(60));
  console.log(`  Low (1-2%):         ${summary.bySeverity.low} signals`);
  console.log(`  Medium (2-3%):      ${summary.bySeverity.medium} signals`);
  console.log(`  High (3-5%):        ${summary.bySeverity.high} signals`);
  console.log(`  Critical (>5%):     ${summary.bySeverity.critical} signals`);
  console.log();

  printSignalsSection(signals);
  printAssessmentSection(summary);

  console.log("\n" + "═".repeat(100) + "\n");
}

export function saveBacktestResults(result: BacktestResult, filename?: string): string {
  const outputFilename = filename ?? `backtest-results-${Date.now()}.json`;

  // Custom replacer to handle BigInt and Date serialization
  function replacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  }

  fs.writeFileSync(
    outputFilename,
    JSON.stringify(
      {
        ...result,
        _note: "Results generated using real PriceMonitor + TradeCalculator services ",
        signals: result.signals.map((s) => ({
          ...s,
          date: s.date.toISOString(),
        })),
        dataRange: {
          ...result.dataRange,
          from: result.dataRange.from.toISOString(),
          to: result.dataRange.to.toISOString(),
        },
        priceStats: {
          ...result.priceStats,
          minDate: result.priceStats.minDate.toISOString(),
          maxDate: result.priceStats.maxDate.toISOString(),
        },
      },
      replacer,
      2
    )
  );
  return outputFilename;
}

async function fetchAndLogCurrentPrices(config: BacktestConfig): Promise<void> {
  console.log("\n📡 Fetching current pool prices...");
  try {
    const currentPrices = await fetchCurrentPoolPrices(config.network, config.poolAddress);
    config.currentLusdPrice = currentPrices.lusdPriceUsd;

    console.log(`   UUSD Price (USD):     $${currentPrices.uusdPriceUsd.toFixed(6)}`);
    console.log(`   LUSD Price (USD):     $${currentPrices.lusdPriceUsd.toFixed(6)}`);
    console.log(`   Pool Ratio (UUSD/LUSD): ${currentPrices.poolRatio.toFixed(6)}`);
    console.log();
    console.log("   ℹ️  Note: Historical OHLCV data shows UUSD/LUSD pool ratio, not USD prices.");
    console.log(`       To estimate USD: multiply ratio by LUSD price (~$${currentPrices.lusdPriceUsd.toFixed(4)})`);
  } catch (error) {
    console.log("   ⚠️  Could not fetch current prices, proceeding with ratio data only", error);
  }
}

async function loadOrFetchCandles(config: BacktestConfig, client: GeckoTerminalClient): Promise<OhlcvCandle[]> {
  if (config.loadFile) {
    console.log(`\n📂 Loading OHLCV data from ${config.loadFile}...`);
    try {
      const raw = JSON.parse(fs.readFileSync(config.loadFile, "utf-8"));
      const candles = parseOhlcvData(raw.data || raw);
      console.log(`   Loaded ${candles.length} candles`);
      return candles;
    } catch (error) {
      throw new Error(`Failed to load file: ${error}`);
    }
  }

  console.log(`\n🔍 Fetching OHLCV data from GeckoTerminal...`);
  console.log(`   Pool: ${config.poolAddress}`);
  console.log(`   Network: ${config.network}`);
  console.log(`   Timeframe: ${config.timeframe}`);
  console.log(`   Date range: ${config.fromDate.toISOString().split("T")[0]} to ${config.toDate.toISOString().split("T")[0]}`);
  console.log(`   Note: Candles only exist for days with trading activity`);

  const maxPages = 5; // Usually 1 page is enough

  const { data: rawData, meta } = await fetchAllOhlcv(client, config.network, config.poolAddress, config.timeframe, maxPages);

  console.log(`   Fetched ${rawData.length} candles`);

  const candles = parseOhlcvData(rawData);

  if (config.saveData) {
    const filename = `ohlcv-${config.network}-${config.poolAddress.slice(0, 10)}-${config.timeframe}-${Date.now()}.json`;
    const filepath = path.join(process.cwd(), filename);
    fs.writeFileSync(filepath, JSON.stringify({ data: rawData, meta }, null, 2));
    console.log(`💾 Saved OHLCV data to ${filename}`);
  }

  return candles;
}

// ============================================================================
// Main Runner
// ============================================================================

export async function runBacktest(options: BacktestOptions = {}): Promise<BacktestResult> {
  const config = buildBacktestConfig(options);

  console.log("\n🚀 UUSD Arbitrage Backtester");
  console.log("─".repeat(50));

  const client = new GeckoTerminalClient({
    timeout: 30000,
    maxRetries: 5,
  });

  await fetchAndLogCurrentPrices(config);

  let candles: OhlcvCandle[] = await loadOrFetchCandles(config, client);

  candles = filterByDateRange(candles, config.fromDate, config.toDate);
  console.log(`\n📊 Analyzing ${candles.length} candles in date range...`);

  if (candles.length === 0) {
    throw new Error("No data found in the specified date range");
  }

  // Fetch pool liquidity for more accurate calculations
  let poolLiquidityUsd: number = DEFAULT_CONFIG.DEFAULT_POOL_LIQUIDITY_USD;
  try {
    const geckoClient = new GeckoTerminalClient();
    const poolData = await geckoClient.getPool(config.network, config.poolAddress);
    if (poolData.data.attributes.reserve_in_usd) {
      poolLiquidityUsd = parseFloat(poolData.data.attributes.reserve_in_usd);
    }
  } catch {
    // Use default
  }

  console.log(`   Using pool liquidity: $${poolLiquidityUsd.toLocaleString()}`);
  console.log(`   ✅ Using PriceMonitor + TradeCalculator `);

  const result = await runBacktestAnalysis(candles, config, { poolLiquidityUsd });

  printBacktestResults(result);

  const resultsFilename = saveBacktestResults(result);
  console.log(`📄 Full results saved to ${resultsFilename}\n`);

  return result;
}
