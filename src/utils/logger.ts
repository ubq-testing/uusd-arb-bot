import { LogLevel, Logs } from "@ubiquity-os/ubiquity-os-logger";

const logLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
export const Logger = new Logs(logLevel);