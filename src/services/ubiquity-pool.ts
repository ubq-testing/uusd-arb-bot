/**
 * UbiquityPool Service
 *
 * Handles interactions with the Ubiquity Diamond contract for:
 * - Minting UUSD (when price >= $1.01)
 * - Redeeming UUSD for collateral (when price <= $0.99)
 * - Querying pool state
 *
 * This bypasses liquidity pools and interacts directly with the protocol's
 * minting/redemption mechanism for peg arbitrage.
 */

import { createPublicClient, createWalletClient, http, type Address, type PublicClient, type WalletClient, type Chain, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { getRpcUrl } from "../types/config";
import ubiquityPoolAbi from "../contracts/abi/ubiquity-pool.json" with { type: "json" };
import erc20Abi from "../contracts/abi/erc20.json" with { type: "json" };
import { logger } from "../utils/logger";

/**
 * Contract addresses for Ubiquity protocol
 */
export const UBIQUITY_CONTRACTS = {
  /** Diamond proxy - main entry point for UbiquityPool interactions */
  DIAMOND: "0xed3084c98148e2528dadcb53c56352e549c488fa" as Address,

  /** UUSD Token */
  UUSD_TOKEN: "0xb6919ef2ee4afc163bc954c5678e2bb570c2d103" as Address,

  /** LUSD Token (collateral) */
  LUSD_TOKEN: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0" as Address,
} as const;

/**
 * Precision constants for Ubiquity Pool
 */
export const UBIQUITY_PRECISION = {
  /** Price precision (1e6 = $1.00) */
  PRICE: 1_000_000n,

  /** Token decimals */
  DECIMALS: 18n,
} as const;

/**
 * Price thresholds enforced by the contract
 * These determine when minting/redemption is allowed
 */
export const PRICE_THRESHOLDS = {
  /** Minimum price to allow minting ($1.01) */
  MINT_THRESHOLD: 1_010_000n,

  /** Maximum price to allow redemption ($0.99) */
  REDEEM_THRESHOLD: 990_000n,
} as const;

/** LUSD collateral index in the pool */
export const LUSD_COLLATERAL_INDEX = 0n;

export interface UbiquityPoolState {
  /** UUSD price from contract oracle (1e6 precision) */
  dollarPriceUsd: bigint;
  /** Current collateral ratio (1e6 = 100%) */
  collateralRatio: bigint;
  /** Free collateral available in pool */
  freeCollateralBalance: bigint;
  /** Whether minting is currently allowed */
  canMint: boolean;
  /** Whether redemption is currently allowed */
  canRedeem: boolean;
}

export interface MintResult {
  totalDollarMint: bigint;
  collateralNeeded: bigint;
  txHash: string;
  gasUsed: bigint;
}

export interface RedeemResult {
  dollarAmount: bigint;
  expectedCollateralOut: bigint;
  txHash: string;
  gasUsed: bigint;
}

export interface CollectResult {
  collateralAmount: bigint;
  txHash: string;
  gasUsed: bigint;
}

export class UbiquityPoolService {
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

  /**
   * Get current UUSD price from the Ubiquity Pool oracle (1e6 precision)
   * This is the price used by the contract to determine mint/redeem eligibility
   */
  async getDollarPriceUsd(): Promise<bigint> {
    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "getDollarPriceUsd",
    }) as Promise<bigint>;
  }

  /**
   * Get current collateral ratio (1e6 = 100%)
   */
  async getCollateralRatio(): Promise<bigint> {
    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "collateralRatio",
    }) as Promise<bigint>;
  }

  /**
   * Get free collateral balance available in pool
   */
  async getFreeCollateralBalance(): Promise<bigint> {
    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "freeCollateralBalance",
      args: [LUSD_COLLATERAL_INDEX],
    }) as Promise<bigint>;
  }

  /**
   * Get user's pending redemption balance (after redeemDollar, before collectRedemption)
   */
  async getRedeemCollateralBalance(userAddress: Address): Promise<bigint> {
    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "getRedeemCollateralBalance",
      args: [userAddress, LUSD_COLLATERAL_INDEX],
    }) as Promise<bigint>;
  }

  /**
   * Get how much collateral is needed to mint a given amount of UUSD
   */
  async getDollarInCollateral(dollarAmount: bigint): Promise<bigint> {
    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "getDollarInCollateral",
      args: [LUSD_COLLATERAL_INDEX, dollarAmount],
    }) as Promise<bigint>;
  }

  /**
   * Check if minting is currently allowed (price >= $1.01)
   */
  async canMint(): Promise<boolean> {
    const price = await this.getDollarPriceUsd();
    return price >= PRICE_THRESHOLDS.MINT_THRESHOLD;
  }

  /**
   * Check if redemption is currently allowed (price <= $0.99)
   */
  async canRedeem(): Promise<boolean> {
    const price = await this.getDollarPriceUsd();
    return price <= PRICE_THRESHOLDS.REDEEM_THRESHOLD;
  }

  /**
   * Get complete pool state
   */
  async getPoolState(): Promise<UbiquityPoolState> {
    const [dollarPriceUsd, collateralRatio, freeCollateralBalance] = await Promise.all([
      this.getDollarPriceUsd(),
      this.getCollateralRatio(),
      this.getFreeCollateralBalance(),
    ]);

    return {
      dollarPriceUsd,
      collateralRatio,
      freeCollateralBalance,
      canMint: dollarPriceUsd >= PRICE_THRESHOLDS.MINT_THRESHOLD,
      canRedeem: dollarPriceUsd <= PRICE_THRESHOLDS.REDEEM_THRESHOLD,
    };
  }

  /**
   * Convert price (1e6) to human-readable USD
   */
  priceToUsd(price: bigint): number {
    return Number(price) / Number(UBIQUITY_PRECISION.PRICE);
  }

  /**
   * Approve LUSD spending for the Diamond contract
   */
  async approveLusd(amount: bigint): Promise<string> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    const hash = await this._walletClient.writeContract({
      chain: mainnet,
      account: this._account,
      address: UBIQUITY_CONTRACTS.LUSD_TOKEN,
      abi: erc20Abi,
      functionName: "approve",
      args: [UBIQUITY_CONTRACTS.DIAMOND, amount],
    });

    await this._publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Approve UUSD spending for the Diamond contract
   */
  async approveUusd(amount: bigint): Promise<string> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    const hash = await this._walletClient.writeContract({
      chain: mainnet,
      account: this._account,
      address: UBIQUITY_CONTRACTS.UUSD_TOKEN,
      abi: erc20Abi,
      functionName: "approve",
      args: [UBIQUITY_CONTRACTS.DIAMOND, amount],
    });

    await this._publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Mint UUSD by depositing LUSD collateral
   * Only works when UUSD price >= $1.01
   *
   * Use case: When UUSD is trading above peg, mint UUSD and sell into the pool
   */
  async mintDollar(dollarAmount: bigint, maxCollateralIn: bigint): Promise<MintResult> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    // Check if minting is allowed
    const canMint = await this.canMint();
    if (!canMint) {
      const price = await this.getDollarPriceUsd();
      throw logger.error("Minting not allowed - price below threshold", {
        currentPrice: this.priceToUsd(price),
        threshold: this.priceToUsd(PRICE_THRESHOLDS.MINT_THRESHOLD),
      });
    }

    // Approve LUSD first
    await this.approveLusd(maxCollateralIn);

    const hash = await this._walletClient.writeContract({
      chain: mainnet,
      account: this._account,
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "mintDollar",
      args: [
        LUSD_COLLATERAL_INDEX,
        dollarAmount,
        0n, // dollarOutMin - no slippage protection for simplicity
        maxCollateralIn,
        0n, // maxGovernanceIn - using 1:1 mode
        true, // isOneToOne
      ],
    });

    const receipt = await this._publicClient.waitForTransactionReceipt({ hash });

    return {
      totalDollarMint: dollarAmount,
      collateralNeeded: maxCollateralIn,
      txHash: hash,
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Redeem UUSD for LUSD collateral
   * Only works when UUSD price <= $0.99
   *
   * Note: Redemption is a 2-step process:
   * 1. redeemDollar() - initiates redemption
   * 2. collectRedemption() - collects collateral (after 2-block delay)
   *
   * Use case: When UUSD is trading below peg, buy cheap UUSD and redeem for $1 worth of collateral
   */
  async redeemDollar(dollarAmount: bigint, minCollateralOut: bigint): Promise<RedeemResult> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    // Check if redemption is allowed
    const canRedeem = await this.canRedeem();
    if (!canRedeem) {
      const price = await this.getDollarPriceUsd();
      throw logger.error("Redemption not allowed - price above threshold", {
        currentPrice: this.priceToUsd(price),
        threshold: this.priceToUsd(PRICE_THRESHOLDS.REDEEM_THRESHOLD),
      });
    }

    // Approve UUSD first
    await this.approveUusd(dollarAmount);

    const hash = await this._walletClient.writeContract({
      chain: mainnet,
      account: this._account,
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "redeemDollar",
      args: [
        LUSD_COLLATERAL_INDEX,
        dollarAmount,
        0n, // governanceOutMin
        minCollateralOut,
      ],
    });

    const receipt = await this._publicClient.waitForTransactionReceipt({ hash });

    return {
      dollarAmount,
      expectedCollateralOut: minCollateralOut,
      txHash: hash,
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Collect redemption after 2-block delay
   * Must be called after redeemDollar() and waiting for 2 blocks
   */
  async collectRedemption(): Promise<CollectResult> {
    if (!this._walletClient || !this._account) {
      throw new Error("Wallet not initialized");
    }

    // Get pending balance before collection
    const pendingBalance = await this.getRedeemCollateralBalance(this._account.address);

    if (pendingBalance === 0n) {
      throw logger.error("No pending redemption to collect");
    }

    const hash = await this._walletClient.writeContract({
      chain: mainnet,
      account: this._account,
      address: UBIQUITY_CONTRACTS.DIAMOND,
      abi: ubiquityPoolAbi,
      functionName: "collectRedemption",
      args: [LUSD_COLLATERAL_INDEX],
    });

    const receipt = await this._publicClient.waitForTransactionReceipt({ hash });

    return {
      collateralAmount: pendingBalance,
      txHash: hash,
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Get LUSD balance of an address
   */
  async getLusdBalance(address?: Address): Promise<bigint> {
    const addr = address ?? this._account?.address;
    if (!addr) throw new Error("No address provided");

    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.LUSD_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>;
  }

  /**
   * Get UUSD balance of an address
   */
  async getUusdBalance(address?: Address): Promise<bigint> {
    const addr = address ?? this._account?.address;
    if (!addr) throw new Error("No address provided");

    return this._publicClient.readContract({
      address: UBIQUITY_CONTRACTS.UUSD_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr],
    }) as Promise<bigint>;
  }

  /**
   * Get the bot's wallet address
   */
  getWalletAddress(): Address | null {
    return this._account?.address ?? null;
  }

  /**
   * Check if wallet is initialized
   */
  hasWallet(): boolean {
    return this._account !== null && this._walletClient !== null;
  }
}
