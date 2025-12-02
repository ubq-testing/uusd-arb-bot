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
  DEVIATION_THRESHOLD: T.Optional(
    T.String({
      description: "Price deviation threshold (e.g., 0.01 for 1%)",
    })
  ),

  /**
   * Optional: Maximum gas price in gwei (default: 50)
   * Note: Trades are delayed (not skipped) if gas is too high
   */
  MAX_GAS_PRICE_GWEI: T.Optional(
    T.String({
      description: "Maximum gas price in gwei",
    })
  ),

  /**
   * Optional: Maximum slippage tolerance (default: 0.01 = 1%)
   */
  MAX_SLIPPAGE: T.Optional(
    T.String({
      description: "Maximum slippage tolerance",
    })
  ),

  /**
   * Optional: Whether to actually execute trades (default: false for safety)
   */
  EXECUTE_ENABLED: T.Optional(
    T.String({
      description: "Whether to execute trades (true/false)",
    })
  ),
});

export type Env = StaticDecode<typeof envSchema>;

export async function validateEnv(env: NodeJS.ProcessEnv): Promise<Env> {
  try {
    const clean = Value.Clean(envSchema, env);

    const errors = [...Value.Errors(envSchema, clean)];
    if (errors.length > 0) {
      logger.error("Invalid environment variables", { errors });
      throw new Error("Invalid environment variables");
    }

    const decoded = Value.Decode(envSchema, Value.Default(envSchema, clean));

    logger.info("Environment validated successfully", {
      hasPrivateKey: !!decoded.HOT_WALLET_PRIVATE_KEY,
      executeEnabled: decoded.EXECUTE_ENABLED === "true",
    });

    return decoded;
  } catch (err) {
    throw logger.error("Failed to validate environment variables", { err });
  }
}
