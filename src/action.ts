import { validateEnv } from "./types/env";
import { Logger } from "./utils/logger";

export default async function main() {
  const env = await validateEnv(process.env);
  Logger.info("Environment variables validated", { env });
}
