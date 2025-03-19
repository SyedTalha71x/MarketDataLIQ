// config.ts
import { configDotenv } from "dotenv";

configDotenv();

export const FIX_SERVER = process.env.FIX_SERVER;
export const FIX_PORT = process.env.FIX_PORT;
export const SENDER_COMP_ID = process.env.SENDER_COMP_ID;
export const TARGET_COMP_ID = process.env.TARGET_COMP_ID;
export const USERNAME = process.env.USERNAME;
export const PASSWORD = process.env.PASSWORD;

export const PG_HOST = process.env.PG_HOST;
export const PG_PORT = process.env.PG_PORT;
export const PG_USER = process.env.PG_USER;
export const PG_PASSWORD = process.env.PG_PASSWORD;
export const PG_DATABASE = process.env.PG_DATABASE;

export const REDIS_HOST = process.env.REDIS_HOST || "localhost";
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379");

export const WS_PORT = 8080

export const timeFrames = {
  M1: 60000, // 1 minute (60000 ms)
  H1: 3600000, // 1 hour (3600000 ms)
  D1: 86400000, // 1 day (86400000 ms)
};

export const MESSAGE_TYPES: Record<string, string> = {
  "0": "Heartbeat",
  "1": "Test Request",
  "2": "Resend Request",
  "3": "Reject",
  "4": "Sequence Reset",
  "5": "Logout",
  A: "Logon",
  V: "Market Data Request",
  W: "Market Data Snapshot",
  X: "Market Data Incremental Refresh",
};

export const MD_ENTRY_TYPES: Record<string, string> = {
  "0": "BID",
  "1": "ASK",
  "2": "TRADE",
  "3": "INDEX_VALUE",
  "4": "OPENING_PRICE",
  "5": "CLOSING_PRICE",
  "6": "SETTLEMENT_PRICE",
  "7": "TRADING_SESSION_HIGH_PRICE",
  "8": "TRADING_SESSION_LOW_PRICE",
};