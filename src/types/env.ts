import { StaticDecode, Type as T } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import "dotenv/config";
import { Logger } from "../utils/logger";

export const envSchema = T.Object({
  HOT_WALLET_PRIVATE_KEY: T.String({
    description: "The private key of the hot wallet",
    pattern: "^0x[a-fA-F0-9]{64}$",
    message: "The private key must be a valid Ethereum private key starting with 0x",
  }),
});

export type Env = StaticDecode<typeof envSchema>;

export async function validateEnv(env: NodeJS.ProcessEnv) {
  try {
    const clean = Value.Clean(envSchema, env);

    if (Value.Errors(envSchema, clean)) {
      throw Logger.error("Invalid environment variables", { errors: Value.Errors(envSchema, clean) });
    }

    return Value.Decode(envSchema, Value.Default(envSchema, clean));
  } catch (err) {
    throw Logger.error("Failed to validate environment variables", { err });
  }
}
