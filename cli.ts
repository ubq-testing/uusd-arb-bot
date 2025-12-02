#!/usr/bin/env bun
/**
 * UUSD Arbitrage Bot CLI
 *
 * Usage: bun run cli.ts <command> [options]
 *
 * Commands:
 *   run          Run the arbitrage bot (default)
 *   backtest     Run historical backtest analysis
 *
 * Run Options:
 *   --dry-run    Run without executing trades (default)
 *   --execute    Enable trade execution
 *
 * Backtest Options:
 *   --timeframe <tf>      Timeframe: day, hour, minute (default: hour)
 *   --from <date>         Start date (YYYY-MM-DD, default: 2025-01-01)
 *   --to <date>           End date (YYYY-MM-DD, default: now)
 *   --threshold <percent> Deviation threshold override
 *   --save                Save OHLCV data to JSON file
 *   --load <file>         Load OHLCV data from JSON file
 *
 * Environment variables can be set in a .env file or passed directly.
 */

import "dotenv/config";
import main from "./src/action";
import { runBacktest, type OhlcvTimeframe } from "./src/services/backtesting/backtester";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "run";

// Helper functions
function getArg(flag: string, defaultValue: string = ""): string {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return defaultValue;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function showHelp(): void {
  console.log(`
UUSD Arbitrage Bot CLI

Usage: bun run cli.ts <command> [options]

Commands:
  run          Run the arbitrage bot (default if no command specified)
  backtest     Run historical backtest analysis
  help         Show this help message

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RUN OPTIONS:

  --dry-run              Run without executing trades (default)
  --execute              Enable trade execution (WARNING: will spend real funds)

  Environment Variables:
    HOT_WALLET_PRIVATE_KEY  Required - Private key for the hot wallet (0x prefixed)
    DEVIATION_THRESHOLD     Optional - Price deviation threshold (default: 0.01 = 1%)
    MAX_GAS_PRICE_GWEI      Optional - Maximum gas price in gwei (default: 50)
    MAX_SLIPPAGE            Optional - Maximum slippage tolerance (default: 0.05 = 5%)
    EXECUTE_ENABLED         Optional - Whether to execute trades (default: false)
    RPC_URL                 Optional - Custom RPC URL for testing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BACKTEST OPTIONS:

  --timeframe <tf>       Timeframe: day, hour, minute (default: hour)
  --from <date>          Start date YYYY-MM-DD (default: 2025-01-01)
  --to <date>            End date YYYY-MM-DD (default: now)
  --threshold <decimal>  Deviation threshold (default: from env or 0.01)
  --save                 Save OHLCV data to JSON file for later use
  --load <file>          Load OHLCV data from previously saved JSON file

  Environment Variables (also used for backtest thresholds):
    DEVIATION_THRESHOLD   Price deviation threshold
    MAX_GAS_PRICE_GWEI    Maximum gas price in gwei
    MAX_SLIPPAGE          Maximum slippage tolerance

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXAMPLES:

  # Run bot in dry-run mode
  bun run cli.ts
  bun run cli.ts run --dry-run

  # Run bot with trade execution enabled
  bun run cli.ts run --execute

  # Run backtest with default settings (6 months, hourly)
  bun run cli.ts backtest

  # Run backtest from specific date
  bun run cli.ts backtest --from 2024-06-01

  # Run backtest with daily data and save for later
  bun run cli.ts backtest --timeframe day --save

  # Load previously saved data for faster analysis
  bun run cli.ts backtest --load ohlcv-eth-0xcc68509f-hour-1733000000.json

  # Run backtest with custom threshold
  bun run cli.ts backtest --threshold 0.005
`);
}

// Command handlers
async function handleRun(): Promise<void> {
  if (hasFlag("--execute")) {
    process.env.EXECUTE_ENABLED = "true";
    console.log("⚠️  EXECUTE MODE ENABLED - Trades will be executed!");
  } else if (hasFlag("--dry-run") || !process.env.EXECUTE_ENABLED) {
    process.env.EXECUTE_ENABLED = "false";
    console.log("ℹ️  Dry run mode - No trades will be executed");
  }

  const report = await main();
  console.log("\n📊 Final Report:");
  console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function handleBacktest(): Promise<void> {
  const thresholdArg = getArg("--threshold");

  await runBacktest({
    timeframe: getArg("--timeframe", "day") as OhlcvTimeframe,
    fromDate: getArg("--from") || undefined,
    toDate: getArg("--to") || undefined,
    threshold: thresholdArg ? parseFloat(thresholdArg) : undefined,
    saveData: hasFlag("--save"),
    loadFile: hasFlag("--load") ? getArg("--load") : null,
  });
}

// Main
async function cli(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h") || command === "help") {
    showHelp();
    return;
  }

  switch (command) {
    case "run":
      await handleRun();
      break;

    case "backtest":
      await handleBacktest();
      break;

    default:
      // If first arg looks like a flag, treat as "run" command
      if (command.startsWith("-")) {
        await handleRun();
      } else {
        console.error(`❌ Unknown command: ${command}`);
        console.log('Run "bun run cli.ts help" for usage information.');
        process.exit(1);
      }
  }
}

cli()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error.message || error);
    process.exit(1);
  });
