import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

/**
 * Configuration for Anvil test instances.
 *
 * IMPORTANT: Anvil must be running BEFORE tests are executed.
 * Start instances in separate terminals:
 *
 * Terminal 1 (Curve tests):
 *   anvil --host 127.0.0.1 --port 8545 --fork-url YOUR_RPC_URL --chain-id 1
 *
 * Terminal 2 (optional, for parallel test suites):
 *   anvil --host 127.0.0.1 --port 8546 --fork-url YOUR_RPC_URL --chain-id 1
 */

export interface AnvilConfig {
  port?: number;
  host?: string;
}

/**
 * Anvil client for integration tests.
 * Connects to a pre-running Anvil instance - does NOT spawn processes.
 *
 * This design allows:
 * 1. Seeing transaction logs in the Anvil terminal
 * 2. Easier debugging and development
 * 3. More reliable test execution
 */
export class AnvilFork {
  private readonly _port: number;
  private readonly _host: string;

  constructor(options: AnvilConfig = {}) {
    this._port = options.port ?? 8545;
    this._host = options.host ?? "127.0.0.1";
  }

  get rpcUrl(): string {
    return `http://${this._host}:${this._port}`;
  }

  /**
   * Check if Anvil is running and responsive.
   * Call this in beforeAll to fail fast if Anvil isn't running.
   */
  async checkConnection(): Promise<void> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = (await response.json()) as { error?: { message: string }; result?: string };
      if (result.error) {
        throw new Error(result.error.message);
      }

      console.log(`✓ Connected to Anvil at ${this.rpcUrl} (block: ${parseInt(result.result ?? "0", 16)})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `  Anvil is not running on ${this.rpcUrl}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `\n` +
          `  Start Anvil in a separate terminal before running tests:\n` +
          `\n` +
          `    anvil --host 127.0.0.1 --port ${this._port} \\\n` +
          `      --fork-url YOUR_RPC_URL \\\n` +
          `      --chain-id 1\n` +
          `\n` +
          `  Or with default RPC:\n` +
          `\n` +
          `    anvil --host 127.0.0.1 --port ${this._port} \\\n` +
          `      --fork-url https://eth.llamarpc.com \\\n` +
          `      --chain-id 1\n` +
          `\n` +
          `  Error: ${msg}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
      );
    }
  }

  /**
   * Get a viem public client connected to Anvil
   */
  getPublicClient(): PublicClient {
    return createPublicClient({
      chain: mainnet,
      transport: http(this.rpcUrl),
    });
  }

  /**
   * Impersonate an account (useful for testing with whale accounts)
   */
  async impersonate(address: string): Promise<void> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_impersonateAccount",
        params: [address],
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      throw new Error(`Failed to impersonate ${address}: ${result.error.message}`);
    }
  }

  /**
   * Stop impersonating an account
   */
  async stopImpersonating(address: string): Promise<void> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_stopImpersonatingAccount",
        params: [address],
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      throw new Error(`Failed to stop impersonating ${address}: ${result.error.message}`);
    }
  }

  /**
   * Set ETH balance for an address
   */
  async setBalance(address: string, balanceWei: bigint): Promise<void> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_setBalance",
        params: [address, `0x${balanceWei.toString(16)}`],
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      throw new Error(`Failed to set balance: ${result.error.message}`);
    }
  }

  /**
   * Mine blocks
   */
  async mineBlocks(count: number): Promise<void> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_mine",
        params: [count, 12], // 12 seconds per block
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      throw new Error(`Failed to mine blocks: ${result.error.message}`);
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<bigint> {
    const client = this.getPublicClient();
    return client.getBlockNumber();
  }

  /**
   * Take a snapshot (for test isolation)
   */
  async snapshot(): Promise<string> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "evm_snapshot",
        params: [],
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string }; result?: string };
    if (result.error) {
      throw new Error(`Failed to snapshot: ${result.error.message}`);
    }
    return result.result as string;
  }

  /**
   * Revert to a snapshot
   */
  async revert(snapshotId: string): Promise<void> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "evm_revert",
        params: [snapshotId],
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      throw new Error(`Failed to revert: ${result.error.message}`);
    }
  }

  /**
   * Reset the fork to a specific block (useful for getting fresh state)
   */
  async resetFork(blockNumber?: number): Promise<void> {
    const params: Record<string, unknown> = {};
    if (blockNumber !== undefined) {
      params.blockNumber = blockNumber;
    }

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "anvil_reset",
        params: [params],
        id: 1,
      }),
    });
    const result = (await response.json()) as { error?: { message: string } };
    if (result.error) {
      throw new Error(`Failed to reset fork: ${result.error.message}`);
    }
  }
}

/**
 * Known whale addresses for testing
 */
export const WHALES = {
  /** Large LUSD holder - Liquidity Stability Pool */
  LUSD_WHALE: "0x66017D22b0f8556afDd19FC67041899Eb65a21bb",
  /** Curve pool with both tokens */
  CURVE_POOL: "0xcC68509F9cA0E1ed119EAC7c468EC1b1C42f384F",
} as const;

/**
 * Test account (Anvil default accounts have 10000 ETH)
 */
export const TEST_ACCOUNTS = {
  DEPLOYER: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // Anvil account 0
  BOT_WALLET: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Anvil account 1
  USER: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Anvil account 2
} as const;

/**
 * Anvil default private keys
 */
export const TEST_PRIVATE_KEYS = {
  DEPLOYER: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  BOT_WALLET: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  USER: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

/**
 * Default Anvil instance - all tests share this
 */
export const DEFAULT_ANVIL_PORT = 8545;
