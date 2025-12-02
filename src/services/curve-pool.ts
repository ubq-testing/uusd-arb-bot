/**
 * Handles all interactions with the Curve LUSD/UUSD StableSwap pool:
 * - Price oracle reading
 * - Pool state queries
 * - Swap execution
 * - Balance checks
 */

import { createPublicClient, createWalletClient, http, type Address, type PublicClient, type WalletClient, type Chain, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, gnosis } from "viem/chains";
import { CONTRACTS, CURVE_POOL_INDICES, PRECISION, getRpcUrl } from "../types/config";
import type { CurvePoolState, WalletBalances } from "../types";
import curvePoolAbi from "../contracts/abi/curve-stable-swap.json" with { type: "json" };
import erc20Abi from "../contracts/abi/erc20.json" with { type: "json" };
import { logger } from "../utils/logger";

export interface SwapResult {
  amountOut: bigint;
  txHash: string;
  gasUsed: bigint;
}

export const CHAIN_MAP = {
  1: mainnet,
  100: gnosis,
};

export const ABI_MAP = {
  curvePool: curvePoolAbi,
  erc20: erc20Abi,
};

export class CurvePoolService {
  private _publicClient: PublicClient;
  private _walletClient: WalletClient | null = null;
  private _account: Account | null = null;

  constructor(privateKey?: string) {
    const rpcUrl = getRpcUrl();

    this._publicClient = createPublicClient({
      chain: mainnet as Chain,
      transport: http(rpcUrl),
    });

    if (privateKey) {
      this._account = privateKeyToAccount(privateKey as `0x${string}`);
      this._walletClient = createWalletClient({
        account: this._account,
        chain: mainnet as Chain,
        transport: http(rpcUrl),
      });
    }
  }

  async writeContract({
    chainId,
    address,
    abi,
    functionName,
    args,
  }: {
    chainId: keyof typeof CHAIN_MAP;
    address: Address;
    abi: keyof typeof ABI_MAP;
    functionName: string;
    args: unknown[];
  }) {
    if (!this._walletClient) {
      throw logger.error("Contract write failed: Wallet client not initialized");
    }

    if (!this._account) {
      throw logger.error("Contract write failed: Account not initialized");
    }

    try {
      return await this._walletClient.writeContract({
        chain: CHAIN_MAP[chainId],
        account: this._account,
        address,
        abi: ABI_MAP[abi],
        functionName,
        args,
      });
    } catch (err) {
      throw logger.error("Contract write failed", {
        err,
        chainId,
        address,
        abi,
        functionName,
        args,
      });
    }
  }

  /**
   * Get UUSD price from Curve oracle (18 decimals)
   * Returns UUSD/LUSD price where LUSD ≈ $1
   */
  async getUusdPrice(): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: curvePoolAbi,
      functionName: "price_oracle",
      args: [0n],
    }) as Promise<bigint>;
  }

  /**
   * Convert Curve oracle price (18 decimals) to USD
   * Assumes LUSD ≈ $1
   */
  priceToUsd(price: bigint): number {
    return Number(price) / Number(PRECISION.WAD);
  }

  /**
   * Get pool balances
   */
  async getBalances(): Promise<{ lusd: bigint; uusd: bigint }> {
    const [lusd, uusd] = await Promise.all([
      this._publicClient.readContract({
        address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
        abi: curvePoolAbi,
        functionName: "balances",
        args: [BigInt(CURVE_POOL_INDICES.LUSD)],
      }) as Promise<bigint>,
      this._publicClient.readContract({
        address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
        abi: curvePoolAbi,
        functionName: "balances",
        args: [BigInt(CURVE_POOL_INDICES.UUSD)],
      }) as Promise<bigint>,
    ]);

    return { lusd, uusd };
  }

  /**
   * Get virtual price (useful for LP value calculation)
   */
  async getVirtualPrice(): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: curvePoolAbi,
      functionName: "get_virtual_price",
    }) as Promise<bigint>;
  }

  /**
   * Get complete pool state
   */
  async getPoolState(): Promise<CurvePoolState> {
    const [uusdPrice, balances, virtualPrice] = await Promise.all([this.getUusdPrice(), this.getBalances(), this.getVirtualPrice()]);

    return {
      uusdPrice,
      lusdBalance: balances.lusd,
      uusdBalance: balances.uusd,
      virtualPrice,
    };
  }

  /**
   * Get expected output for swapping LUSD -> UUSD (buying UUSD)
   */
  async getLusdToUusdQuote(lusdAmount: bigint): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: curvePoolAbi,
      functionName: "get_dy",
      args: [BigInt(CURVE_POOL_INDICES.LUSD), BigInt(CURVE_POOL_INDICES.UUSD), lusdAmount],
    }) as Promise<bigint>;
  }

  /**
   * Get expected output for swapping UUSD -> LUSD (selling UUSD)
   */
  async getUusdToLusdQuote(uusdAmount: bigint): Promise<bigint> {
    return this._publicClient.readContract({
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: curvePoolAbi,
      functionName: "get_dy",
      args: [BigInt(CURVE_POOL_INDICES.UUSD), BigInt(CURVE_POOL_INDICES.LUSD), uusdAmount],
    }) as Promise<bigint>;
  }

  /**
   * Calculate slippage for a given swap
   */
  async calculateSlippage(fromToken: "lusd" | "uusd", amount: bigint): Promise<number> {
    const quote = fromToken === "lusd" ? await this.getLusdToUusdQuote(amount) : await this.getUusdToLusdQuote(amount);

    // Perfect 1:1 would mean quote === amount
    return 1 - Number(quote) / Number(amount);
  }

  /**
   * Simulate a swap to get accurate gas estimate
   */
  async estimateSwapGas(fromToken: "lusd" | "uusd", amount: bigint, minAmountOut: bigint): Promise<bigint> {
    if (!this._account) {
      throw new Error("Wallet not initialized for gas estimation");
    }

    const fromIndex = fromToken === "lusd" ? CURVE_POOL_INDICES.LUSD : CURVE_POOL_INDICES.UUSD;
    const toIndex = fromToken === "lusd" ? CURVE_POOL_INDICES.UUSD : CURVE_POOL_INDICES.LUSD;

    try {
      const gasEstimate = await this._publicClient.estimateContractGas({
        address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
        abi: curvePoolAbi,
        functionName: "exchange",
        args: [BigInt(fromIndex), BigInt(toIndex), amount, minAmountOut],
        account: this._account.address,
      });

      // Add buffer for approval gas (standard ERC20 approve ~46k gas + buffer as this varies)
      return gasEstimate + 60000n;
    } catch (err) {
      throw logger.error("Gas estimation failed", { err });
    }
  }

  /**
   * Swap LUSD for UUSD (buying UUSD when price < $1)
   */
  async swapLusdToUusd(lusdAmount: bigint, minUusdOut: bigint): Promise<SwapResult> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    // Approve LUSD for Curve pool
    const approveHash = await this.writeContract({
      chainId: 1,
      address: CONTRACTS.LUSD_TOKEN,
      abi: "erc20",
      functionName: "approve",
      args: [CONTRACTS.CURVE_LUSD_UUSD_POOL, lusdAmount],
    });

    const approveReceipt = await this._publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Get quote before swap
    const expectedOut = await this.getLusdToUusdQuote(lusdAmount);

    // Execute swap
    const hash = await this.writeContract({
      chainId: 1,
      address: CONTRACTS.CURVE_LUSD_UUSD_POOL,
      abi: "curvePool",
      functionName: "exchange",
      args: [BigInt(CURVE_POOL_INDICES.LUSD), BigInt(CURVE_POOL_INDICES.UUSD), lusdAmount, minUusdOut],
    });

    const receipt = await this._publicClient.waitForTransactionReceipt({ hash });

    return {
      amountOut: expectedOut,
      txHash: hash,
      gasUsed: approveReceipt.gasUsed + receipt.gasUsed,
    };
  }

  /**
   * Swap UUSD for LUSD (selling UUSD when price > $1)
   */
  async swapUusdToLusd(uusdAmount: bigint, minLusdOut: bigint): Promise<SwapResult> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    // Approve UUSD for Curve pool
    const approveHash = await this.writeContract({
      chainId: 1,
      address: CONTRACTS.UUSD_TOKEN,
      abi: "erc20",
      functionName: "approve",
      args: [CONTRACTS.CURVE_LUSD_UUSD_POOL, uusdAmount],
    });

    const approveReceipt = await this._publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Get quote before swap
    const expectedOut = await this.getUusdToLusdQuote(uusdAmount);

    // Execute swap
    const hash = await this.writeContract({
      chainId: 1,
      address: CONTRACTS.UUSD_TOKEN,
      abi: "curvePool",
      functionName: "exchange",
      args: [BigInt(CURVE_POOL_INDICES.UUSD), BigInt(CURVE_POOL_INDICES.LUSD), uusdAmount, minLusdOut],
    });

    const receipt = await this._publicClient.waitForTransactionReceipt({ hash });

    return {
      amountOut: expectedOut,
      txHash: hash,
      gasUsed: approveReceipt.gasUsed + receipt.gasUsed,
    };
  }

  /**
   * Get wallet balances for LUSD, UUSD, and ETH
   */
  async getWalletBalances(address?: Address): Promise<WalletBalances> {
    const walletAddress = address ?? this._account?.address;
    if (!walletAddress) {
      throw new Error("No address provided and wallet not initialized");
    }

    const [lusd, uusd, eth] = await Promise.all([
      this._publicClient.readContract({
        address: CONTRACTS.LUSD_TOKEN,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      }) as Promise<bigint>,
      this._publicClient.readContract({
        address: CONTRACTS.UUSD_TOKEN,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      }) as Promise<bigint>,
      this._publicClient.getBalance({ address: walletAddress }),
    ]);

    return { lusd, uusd, eth };
  }

  /**
   * Get current gas price in wei
   */
  async getGasPrice(): Promise<bigint> {
    return this._publicClient.getGasPrice();
  }

  /**
   * Get the bot's wallet address
   */
  getWalletAddress(): Address | null {
    return this._account?.address ?? null;
  }

  /**
   * Check if wallet is initialized for trading
   */
  hasWallet(): boolean {
    return this._account !== null && this._walletClient !== null;
  }
}
