import type { Config } from "jest";

/**
 * Jest configuration for integration tests.
 *
 * These tests run against a local Anvil fork of Ethereum mainnet
 * and have longer timeouts for blockchain interactions.
 *
 * IMPORTANT: Start Anvil manually before running tests:
 *   anvil --host 127.0.0.1 --port 8545 --fork-url YOUR_RPC_URL --chain-id 1
 *
 * Run with: npm run test:integration
 */
const cfg: Config = {
  transform: {
    "^.+\\.tsx?$": "@swc/jest",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  // Only run integration tests
  testMatch: ["**/tests/integration/**/*.integration.test.ts"],
  // Longer timeout for blockchain interactions
  testTimeout: 120000,
  // All tests share the same Anvil instance, run sequentially
  maxWorkers: 1,
  // No coverage for integration tests
  collectCoverage: false,
  reporters: ["default", "jest-md-dashboard"],
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFilesAfterEnv: ["dotenv/config"],
  // Verbose output for debugging
  verbose: true,
};

export default cfg;
