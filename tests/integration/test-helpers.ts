import { createWalletClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { CONTRACTS } from "../../src/types/config";
import { AnvilFork, WHALES } from "./anvil";

// Standard ERC20 ABI for transfers
const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// Curve pool ABI
const CURVE_POOL_ABI = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
  "function price_oracle(uint256 k) view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
]);

/**
 * Test helper class for integration tests
 */
export class TestHelper {
  private _anvil: AnvilFork;
  private _publicClient: PublicClient;
  private _snapshotId: string | null = null;

  constructor(anvil: AnvilFork) {
    this._anvil = anvil;
    this._publicClient = anvil.getPublicClient();
  }

  /**
   * Fund an address with LUSD from a whale
   */
  async fundWithLusd(recipient: Address, amount: bigint): Promise<void> {
    // Impersonate LUSD whale
    await this._anvil.impersonate(WHALES.LUSD_WHALE);

    // Create wallet client for whale
    const walletClient = createWalletClient({
      chain: mainnet,
      transport: http(this._anvil.rpcUrl),
      account: WHALES.LUSD_WHALE as Address,
    });

    // Transfer LUSD
    const hash = await walletClient.writeContract({
      address: CONTRACTS.LUSD_TOKEN,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [recipient, amount],
    });

    // Wait for confirmation
    await this._publicClient.waitForTransactionReceipt({ hash });

    await this._anvil.stopImpersonating(WHALES.LUSD_WHALE);
  }

  /**
   * Get LUSD balance
   */
  async getLusdBalance(address: Address): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.LUSD_TOKEN,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    });
  }

  /**
   * Get UUSD balance
   */
  async getUusdBalance(address: Address): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.UUSD_TOKEN,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    });
  }

  /**
   * Get UUSD price from Curve oracle (18 decimals)
   */
  async getUusdPriceFromCurve(): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "price_oracle",
      args: [0n],
    });
  }

  /**
   * Get Curve pool balances
   */
  async getCurvePoolBalances(): Promise<{ lusd: bigint; uusd: bigint }> {
    const [lusd, uusd] = await Promise.all([
      this._publicClient.readContract({
        address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
        abi: CURVE_POOL_ABI,
        functionName: "balances",
        args: [0n],
      }),
      this._publicClient.readContract({
        address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
        abi: CURVE_POOL_ABI,
        functionName: "balances",
        args: [1n],
      }),
    ]);
    return { lusd, uusd };
  }

  /**
   * Get virtual price from Curve pool
   */
  async getVirtualPrice(): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "get_virtual_price",
    });
  }

  /**
   * Get expected swap output from Curve
   */
  async getCurveSwapQuote(fromToken: "lusd" | "uusd", amount: bigint): Promise<bigint> {
    const i = fromToken === "lusd" ? 0n : 1n;
    const j = fromToken === "lusd" ? 1n : 0n;

    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "get_dy",
      args: [i, j, amount],
    });
  }

  /**
   * Execute a Curve swap as an impersonated address.
   * Waits for transaction confirmation and throws if it reverts.
   */
  async executeCurveSwap(sender: Address, fromToken: "lusd" | "uusd", amount: bigint, minOut: bigint): Promise<string> {
    await this._anvil.impersonate(sender);

    const walletClient = createWalletClient({
      chain: mainnet,
      transport: http(this._anvil.rpcUrl),
      account: sender,
    });

    const i = fromToken === "lusd" ? 0n : 1n;
    const j = fromToken === "lusd" ? 1n : 0n;
    const tokenAddress = fromToken === "lusd" ? CONTRACTS.LUSD_TOKEN : CONTRACTS.UUSD_TOKEN;

    // Approve first
    const approveHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.CURVE_LUSD_UUSD_POOL, amount],
    });

    // Wait for approval confirmation
    const approveReceipt = await this._publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status === "reverted") {
      await this._anvil.stopImpersonating(sender);
      throw new Error("Approval transaction reverted");
    }

    // Execute swap
    const hash = await walletClient.writeContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "exchange",
      args: [i, j, amount, minOut],
    });

    // Wait for swap confirmation and check status
    const receipt = await this._publicClient.waitForTransactionReceipt({ hash });

    await this._anvil.stopImpersonating(sender);

    if (receipt.status === "reverted") {
      throw new Error("Swap transaction reverted: min_dy not met");
    }

    return hash;
  }

  /**
   * Create a price deviation scenario by manipulating the Curve pool
   * This simulates market conditions where UUSD trades above/below peg
   *
   * Note: This affects spot price immediately. The Curve `price_oracle` is a TWAP
   * that updates slowly, so use `getSpotPrice()` to verify immediate changes.
   */
  async createPriceDeviation(direction: "above" | "below", magnitude: number = 0.02): Promise<void> {
    // To push UUSD above peg: add more LUSD (buy pressure)
    // To push UUSD below peg: add more UUSD (sell pressure)

    const balances = await this.getCurvePoolBalances();
    const swapAmount = (balances.lusd * BigInt(Math.floor(magnitude * 100))) / 100n;

    if (direction === "above") {
      // Swap LUSD for UUSD (increases UUSD price)
      await this._anvil.impersonate(WHALES.LUSD_WHALE);

      const walletClient = createWalletClient({
        chain: mainnet,
        transport: http(this._anvil.rpcUrl),
        account: WHALES.LUSD_WHALE as Address,
      });

      const approveHash = await walletClient.writeContract({
        address: CONTRACTS.LUSD_TOKEN,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [CONTRACTS.CURVE_LUSD_UUSD_POOL, swapAmount],
      });
      await this._publicClient.waitForTransactionReceipt({ hash: approveHash });

      const swapHash = await walletClient.writeContract({
        address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
        abi: CURVE_POOL_ABI,
        functionName: "exchange",
        args: [0n, 1n, swapAmount, 0n],
      });
      await this._publicClient.waitForTransactionReceipt({ hash: swapHash });

      await this._anvil.stopImpersonating(WHALES.LUSD_WHALE);

      // Mine blocks to help TWAP oracle update
      await this._anvil.mineBlocks(10);
    } else {
      // Swap UUSD for LUSD (decreases UUSD price)
      // We need to find a UUSD holder or mint some first
      // For now, we can use the pool's own balance by impersonating it
      // This is a simulation - in reality we'd need a different approach
      console.log("Creating below-peg scenario requires UUSD holder impersonation");
    }
  }

  /**
   * Get spot price by checking swap rate for a small amount.
   * Unlike price_oracle (TWAP), this reflects the current pool state immediately.
   */
  async getSpotPrice(): Promise<number> {
    const oneToken = 10n ** 18n; // 1 token
    const quote = await this.getCurveSwapQuote("lusd", oneToken);
    // If 1 LUSD gets you X UUSD, then UUSD price = 1/X in terms of LUSD
    return Number(oneToken) / Number(quote);
  }

  /**
   * Save current state
   */
  async saveSnapshot(): Promise<void> {
    this._snapshotId = await this._anvil.snapshot();
  }

  /**
   * Restore to saved state
   */
  async restoreSnapshot(): Promise<void> {
    if (this._snapshotId) {
      await this._anvil.revert(this._snapshotId);
    }
  }

  /**
   * Log current market state
   */
  async logMarketState(): Promise<void> {
    const [curvePrice, balances, virtualPrice] = await Promise.all([this.getUusdPriceFromCurve(), this.getCurvePoolBalances(), this.getVirtualPrice()]);

    console.log("\n=== Market State ===");
    console.log(`Curve oracle price: $${(Number(curvePrice) / 1e18).toFixed(4)}`);
    console.log(`Curve LUSD balance: ${(Number(balances.lusd) / 1e18).toFixed(2)}`);
    console.log(`Curve UUSD balance: ${(Number(balances.uusd) / 1e18).toFixed(2)}`);
    console.log(`Virtual price: ${(Number(virtualPrice) / 1e18).toFixed(6)}`);
    console.log("====================\n");
  }
}

/**
 * Format token amount from wei to human readable
 */
export function formatTokenAmount(amount: bigint, decimals: number = 18): string {
  return (Number(amount) / 10 ** decimals).toFixed(4);
}

/**
 * Parse token amount from human readable to wei
 */
export function parseTokenAmount(amount: number, decimals: number = 18): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}
