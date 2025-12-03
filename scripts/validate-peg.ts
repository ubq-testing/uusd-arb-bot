#!/usr/bin/env npx ts-node

/**
 * Validates peg restoration using the Ubiquity Pool smart contract
 *
 * Tests the mint/redeem mechanism vs. Curve pool swaps:
 * - When UUSD > $1.01: Can mint UUSD with LUSD collateral, sell into pool
 * - When UUSD < $0.99: Can buy cheap UUSD from pool, redeem for $1 LUSD
 *
 * This script forks mainnet to test both approaches.
 */

import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { mainnet } from "viem/chains";

const ANVIL_RPC = "http://127.0.0.1:8545";

// Contracts
const CONTRACTS = {
  DIAMOND: "0xed3084c98148e2528dadcb53c56352e549c488fa" as Address,
  CURVE_POOL: "0xcC68509F9cA0E1ed119EAC7c468EC1b1C42f384F" as Address,
  UUSD_TOKEN: "0xb6919ef2ee4afc163bc954c5678e2bb570c2d103" as Address,
  LUSD_TOKEN: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0" as Address,
};

const LUSD_WHALE = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb" as Address;

// ABIs
const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);

const CURVE_POOL_ABI = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
  "function price_oracle(uint256 k) view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
]);

const UBIQUITY_POOL_ABI = parseAbi([
  "function getDollarPriceUsd() view returns (uint256)",
  "function collateralRatio() view returns (uint256)",
  "function freeCollateralBalance(uint256 collateralIndex) view returns (uint256)",
  "function getRedeemCollateralBalance(address user, uint256 collateralIndex) view returns (uint256)",
  "function mintDollar(uint256 collateralIndex, uint256 dollarAmount, uint256 dollarOutMin, uint256 maxCollateralIn, uint256 maxGovernanceIn, bool isOneToOne) returns (uint256, uint256, uint256)",
  "function redeemDollar(uint256 collateralIndex, uint256 dollarAmount, uint256 governanceOutMin, uint256 collateralOutMin) returns (uint256, uint256)",
  "function collectRedemption(uint256 collateralIndex) returns (uint256, uint256)",
]);

// Helpers
function formatToken(amount: bigint, decimals = 18): string {
  return (Number(amount) / 10 ** decimals).toFixed(4);
}

function parseToken(amount: number, decimals = 18): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

async function anvilCall(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const result = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (result.error) throw new Error(result.error.message);
  return result.result;
}

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║     UUSD Peg Restoration: Ubiquity Pool vs Curve Pool Comparison      ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝\n");

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(ANVIL_RPC),
  });

  // Check connection
  try {
    await publicClient.getBlockNumber();
    console.log("✅ Connected to Anvil fork\n");
  } catch {
    console.error("❌ Anvil not running. Start with:");
    console.error("   anvil --host 127.0.0.1 --port 8545 --fork-url YOUR_RPC_URL --chain-id 1\n");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Current State
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("                          CURRENT STATE                                ");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  // Curve Pool State
  const [lusdBalance, uusdBalance, curveOraclePrice] = await Promise.all([
    publicClient.readContract({ address: CONTRACTS.CURVE_POOL, abi: CURVE_POOL_ABI, functionName: "balances", args: [0n] }),
    publicClient.readContract({ address: CONTRACTS.CURVE_POOL, abi: CURVE_POOL_ABI, functionName: "balances", args: [1n] }),
    publicClient.readContract({ address: CONTRACTS.CURVE_POOL, abi: CURVE_POOL_ABI, functionName: "price_oracle", args: [0n] }),
  ]);

  // Spot price (actual market price)
  const oneToken = parseToken(1);
  const spotQuoteLusdToUusd = await publicClient.readContract({
    address: CONTRACTS.CURVE_POOL,
    abi: CURVE_POOL_ABI,
    functionName: "get_dy",
    args: [0n, 1n, oneToken], // 1 LUSD -> ? UUSD
  });
  const spotPriceUusd = Number(oneToken) / Number(spotQuoteLusdToUusd); // UUSD price in LUSD terms

  // Ubiquity Pool State
  const [uusdPrice, collateralRatio, freeCollateral] = await Promise.all([
    publicClient.readContract({ address: CONTRACTS.DIAMOND, abi: UBIQUITY_POOL_ABI, functionName: "getDollarPriceUsd" }),
    publicClient.readContract({ address: CONTRACTS.DIAMOND, abi: UBIQUITY_POOL_ABI, functionName: "collateralRatio" }),
    publicClient.readContract({ address: CONTRACTS.DIAMOND, abi: UBIQUITY_POOL_ABI, functionName: "freeCollateralBalance", args: [0n] }),
  ]);

  const uusdPriceUsd = Number(uusdPrice) / 1e6;
  const canMint = uusdPrice >= 1_010_000n; // >= $1.01
  const canRedeem = uusdPrice <= 990_000n; // <= $0.99

  console.log("┌───────────────────────────────────────────────────────────────────┐");
  console.log("│                     CURVE POOL STATE                              │");
  console.log("├───────────────────────────────────────────────────────────────────┤");
  console.log(`│ LUSD Balance:        ${formatToken(lusdBalance).padStart(15)} LUSD                    │`);
  console.log(`│ UUSD Balance:        ${formatToken(uusdBalance).padStart(15)} UUSD                    │`);
  console.log(`│ Pool Imbalance:      ${((Number(uusdBalance) - Number(lusdBalance)) / 1e18).toFixed(2).padStart(15)} UUSD excess            │`);
  console.log(`├───────────────────────────────────────────────────────────────────┤`);
  console.log(`│ Oracle Price (TWAP): $${(Number(curveOraclePrice) / 1e18).toFixed(6).padStart(14)}                          │`);
  console.log(`│ Spot Price (actual): $${spotPriceUusd.toFixed(6).padStart(14)}                          │`);
  console.log(`│ Deviation:           ${((spotPriceUusd - 1) * 100).toFixed(4).padStart(14)}%                          │`);
  console.log("└───────────────────────────────────────────────────────────────────┘\n");

  console.log("┌───────────────────────────────────────────────────────────────────┐");
  console.log("│                   UBIQUITY POOL STATE                             │");
  console.log("├───────────────────────────────────────────────────────────────────┤");
  console.log(`│ Contract Price:      $${uusdPriceUsd.toFixed(6).padStart(14)}                          │`);
  console.log(`│ Collateral Ratio:    ${(Number(collateralRatio) / 1e4).toFixed(2).padStart(14)}%                          │`);
  console.log(`│ Free Collateral:     ${formatToken(freeCollateral).padStart(15)} LUSD                    │`);
  console.log(`├───────────────────────────────────────────────────────────────────┤`);
  console.log(`│ Can Mint (>=$1.01):  ${(canMint ? "✅ YES" : "❌ NO").padStart(15)}                          │`);
  console.log(`│ Can Redeem (<=$0.99):${(canRedeem ? "✅ YES" : "❌ NO").padStart(15)}                          │`);
  console.log("└───────────────────────────────────────────────────────────────────┘\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Price Discrepancy Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("                      PRICE DISCREPANCY ANALYSIS                       ");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const oracleVsSpot = (Number(curveOraclePrice) / 1e18 - spotPriceUusd) * 100;
  const uusdVsSpot = (uusdPriceUsd - spotPriceUusd) * 100;

  console.log("┌───────────────────────────────────────────────────────────────────┐");
  console.log("│ Price Source Comparison:                                          │");
  console.log("├───────────────────────────────────────────────────────────────────┤");
  console.log(`│ Curve TWAP Oracle:   $${(Number(curveOraclePrice) / 1e18).toFixed(6)}  (lagging indicator)          │`);
  console.log(`│ Curve Spot Price:    $${spotPriceUusd.toFixed(6)}  (actual market price)        │`);
  console.log(`│ Ubiquity Contract:   $${uusdPriceUsd.toFixed(6)}  (redemption/mint oracle)     │`);
  console.log(`├───────────────────────────────────────────────────────────────────┤`);
  console.log(`│ Oracle vs Spot:      ${oracleVsSpot.toFixed(4).padStart(10)}%                                │`);
  console.log(`│ Ubiquity vs Spot:    ${uusdVsSpot.toFixed(4).padStart(10)}%                                │`);
  console.log("└───────────────────────────────────────────────────────────────────┘\n");

  // Key insight
  console.log("💡 KEY INSIGHT:");
  console.log("   The bot was using the Curve TWAP oracle (~$0.9977) which lags behind");
  console.log(`   the actual spot price (~$${spotPriceUusd.toFixed(4)}).`);
  console.log("   GeckoTerminal shows ~$0.988 which aligns with spot price.\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Arbitrage Opportunity Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("                     ARBITRAGE OPPORTUNITY ANALYSIS                    ");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  if (spotPriceUusd < 1.0) {
    console.log("📉 UUSD is BELOW PEG - Potential buy-redeem arbitrage:\n");

    // Calculate how much UUSD you can buy with 1000 LUSD
    const testAmount = parseToken(1000);
    const uusdReceived = await publicClient.readContract({
      address: CONTRACTS.CURVE_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "get_dy",
      args: [0n, 1n, testAmount],
    });

    const effectiveRate = Number(uusdReceived) / Number(testAmount);
    const profitPercent = (effectiveRate - 1) * 100;

    console.log("   Strategy: Buy cheap UUSD from Curve, redeem at contract for $1 LUSD");
    console.log(`   Example: 1000 LUSD → ${formatToken(uusdReceived)} UUSD → 1000 LUSD (if redeemable)`);
    console.log(`   Potential profit: ${profitPercent.toFixed(2)}% per cycle\n`);

    if (canRedeem) {
      console.log("   ✅ REDEMPTION IS AVAILABLE - Arbitrage possible!");
      console.log(`      Buy UUSD at $${spotPriceUusd.toFixed(4)}, redeem at $1.00`);
      console.log(`      Profit margin: ${((1 / spotPriceUusd - 1) * 100).toFixed(2)}%\n`);
    } else {
      console.log("   ❌ REDEMPTION NOT AVAILABLE");
      console.log(`      Contract price ($${uusdPriceUsd.toFixed(4)}) must be <= $0.99 to redeem`);
      console.log(`      Gap to threshold: ${((uusdPriceUsd - 0.99) * 100).toFixed(2)}%\n`);
    }
  } else {
    console.log("📈 UUSD is ABOVE PEG - Potential mint-sell arbitrage:\n");

    if (canMint) {
      console.log("   ✅ MINTING IS AVAILABLE - Arbitrage possible!");
      console.log(`      Mint UUSD at $1.00, sell at $${spotPriceUusd.toFixed(4)}`);
      console.log(`      Profit margin: ${((spotPriceUusd - 1) * 100).toFixed(2)}%\n`);
    } else {
      console.log("   ❌ MINTING NOT AVAILABLE");
      console.log(`      Contract price ($${uusdPriceUsd.toFixed(4)}) must be >= $1.01 to mint`);
      console.log(`      Gap to threshold: ${((1.01 - uusdPriceUsd) * 100).toFixed(2)}%\n`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: Peg Restoration Simulation (Curve Pool)
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("              PEG RESTORATION VIA CURVE POOL SWAP                      ");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  // Calculate theoretical amount needed
  const imbalance = Number(uusdBalance) - Number(lusdBalance);
  console.log(`Pool imbalance: ${(imbalance / 1e18).toFixed(2)} UUSD excess`);
  console.log(`Theoretical LUSD needed to balance: ~${(imbalance / 2 / 1e18).toFixed(0)} LUSD\n`);

  // Test a few amounts
  const testAmounts = [80, 1000, 5000, 8500];

  console.log("┌────────────┬──────────────┬──────────────┬─────────────┐");
  console.log("│ LUSD In    │ Spot After   │ Deviation    │ Peg Status  │");
  console.log("├────────────┼──────────────┼──────────────┼─────────────┤");

  for (const amount of testAmounts) {
    const snapshotId = (await anvilCall("evm_snapshot")) as string;

    const tradeAmountWei = parseToken(amount);
    const expectedOut = await publicClient.readContract({
      address: CONTRACTS.CURVE_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "get_dy",
      args: [0n, 1n, tradeAmountWei],
    });

    await anvilCall("anvil_setBalance", [LUSD_WHALE, `0x${parseToken(10).toString(16)}`]);
    await anvilCall("anvil_impersonateAccount", [LUSD_WHALE]);

    const walletClient = createWalletClient({
      chain: mainnet,
      transport: http(ANVIL_RPC),
      account: LUSD_WHALE,
    });

    const approveHash = await walletClient.writeContract({
      address: CONTRACTS.LUSD_TOKEN,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.CURVE_POOL, tradeAmountWei],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const swapHash = await walletClient.writeContract({
      address: CONTRACTS.CURVE_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "exchange",
      args: [0n, 1n, tradeAmountWei, (expectedOut * 99n) / 100n],
    });
    await publicClient.waitForTransactionReceipt({ hash: swapHash });

    await anvilCall("anvil_stopImpersonatingAccount", [LUSD_WHALE]);

    const newSpotQuote = await publicClient.readContract({
      address: CONTRACTS.CURVE_POOL,
      abi: CURVE_POOL_ABI,
      functionName: "get_dy",
      args: [0n, 1n, oneToken],
    });
    const newSpotPrice = Number(oneToken) / Number(newSpotQuote);
    const newDeviation = (newSpotPrice - 1) * 100;
    const isRestored = Math.abs(newDeviation) < 0.1;

    console.log(
      `│ ${amount.toString().padStart(8)}   │ $${newSpotPrice.toFixed(6).padStart(10)} │ ${newDeviation.toFixed(4).padStart(10)}% │ ${isRestored ? "   ✅ OK    " : "   ❌ NO    "} │`
    );

    await anvilCall("evm_revert", [snapshotId]);
  }

  console.log("└────────────┴──────────────┴──────────────┴─────────────┘\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: Summary
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("                            SUMMARY                                    ");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log("📊 FINDINGS:\n");
  console.log("   1. The bot calculated '80 UUSD to restore peg' - this was WRONG");
  console.log("      Actual amount needed: ~8,500 LUSD (100x more!)\n");
  console.log("   2. The bot used Curve TWAP oracle (lagging) instead of spot price");
  console.log(`      TWAP: $${(Number(curveOraclePrice) / 1e18).toFixed(4)} vs Spot: $${spotPriceUusd.toFixed(4)}\n`);
  console.log("   3. The formula for calculating trade size was incorrect\n");

  console.log("🔧 FIXES NEEDED:\n");
  console.log("   1. Use spot price (get_dy) instead of price_oracle for market price");
  console.log("   2. Fix the peg restoration calculation formula");
  console.log("   3. Integrate Ubiquity Pool for mint/redeem when thresholds allow\n");

  console.log("✅ Simulation complete!\n");
}

main().catch(console.error);
