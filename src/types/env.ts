import { StaticDecode, Type as T } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import "dotenv/config";
import { logger } from "../utils/logger";

export const envSchema = T.Object({
  /**
   * Required: Private key for the hot wallet that will execute trades
   */
  HOT_WALLET_PRIVATE_KEY: T.String({
    description: "The private key of the hot wallet",
    pattern: "^0x[a-fA-F0-9]{64}$",
  }),

  /**
   * Optional: Price deviation threshold to trigger action (default: 0.01 = 1%)
   */
  DEVIATION_THRESHOLD: T.Transform(T.Union([T.Number(), T.String()], { default: 0.01, description: "Price deviation threshold (e.g., 0.01 for 1%)" }))
    .Decode((value) => {
      if (typeof value === "string") {
        return parseFloat(value);
      }
      return value;
    })
    .Encode((value) => value.toString()),

  /**
   * Maximum gas price in gwei (default: 50)
   * Note: Trades are delayed (not skipped) if gas is too high
   */
  MAX_GAS_PRICE_GWEI: T.Transform(T.Union([T.Number(), T.String()], { default: 50, description: "Maximum gas price in gwei" }))
    .Decode((value) => {
      if (typeof value === "string") {
        return parseInt(value);
      }
      return value;
    })
    .Encode((value) => value.toString()),

  /**
   * Maximum slippage tolerance (default: 0.01 = 1%)
   */
  MAX_SLIPPAGE: T.Transform(T.Union([T.Number(), T.String()], { default: 0.01, description: "Maximum slippage tolerance (e.g., 0.01 for 1%)" }))
    .Decode((value) => {
      if (typeof value === "string") {
        return parseFloat(value);
      }
      return value;
    })
    .Encode((value) => value.toString()),

  /**
   * Whether to actually execute trades (default: false for safety)
   */
  EXECUTE_ENABLED: T.Transform(T.Union([T.Boolean({}), T.String()], { default: false, description: "Whether to execute trades (true/false)" }))
    .Decode((value) => {
      if (typeof value === "string") {
        return value.toLowerCase() === "true";
      }
      return value;
    })
    .Encode((value) => value.toString()),

  /**
   * Strategy mode for peg restoration (default: curve-swap)
   * - curve-swap: Buy/sell UUSD directly in the Curve LUSD/UUSD pool
   * - ubiquity-pool: Use Ubiquity Diamond contract to mint/redeem UUSD
   *   (mint when price >= $1.01, redeem when price <= $0.99)
   */
  STRATEGY_MODE: T.Transform(
    T.Union([T.Literal("curve-swap"), T.Literal("ubiquity-pool"), T.String()], {
      default: "curve-swap",
      description: "Strategy mode: curve-swap or ubiquity-pool",
    })
  )
    .Decode((value) => {
      const normalized = value.toLowerCase().trim();
      if (normalized === "ubiquity-pool" || normalized === "ubiquity") {
        return "ubiquity-pool" as const;
      }
      return "curve-swap" as const;
    })
    .Encode((value) => value),
});

export type Env = StaticDecode<typeof envSchema>;

export async function validateEnv(env: NodeJS.ProcessEnv): Promise<Env> {
  try {
    // First apply defaults to get all required fields
    const withDefaults = Value.Default(envSchema, env);
    const clean = Value.Clean(envSchema, withDefaults);

    const errors = [...Value.Errors(envSchema, clean)];
    if (errors.length > 0) {
      logger.error("Invalid environment variables", { errors });
      throw new Error("Invalid environment variables");
    }

    return Value.Decode(envSchema, clean);
  } catch (err) {
    throw logger.error("Failed to validate environment variables", { err });
  }
}
