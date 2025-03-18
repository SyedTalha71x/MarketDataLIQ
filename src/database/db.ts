import { Pool } from "pg";
import {
  PG_HOST,
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  PG_DATABASE,
} from "../../config.ts";

export const pgPool = new Pool({
  host: PG_HOST,
  port: PG_PORT ? Number(PG_PORT) : 5432,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
});

export interface CurrencyPairInfo {
  currpair: string;
  contractsize: number | null;
}

export let availableCurrencyPairs: CurrencyPairInfo[] = [];
export const subscribedPairs: Set<string> = new Set();

export const ensureTableExists = async (
  tableName: string,
  type: "BID" | "ASK"
): Promise<void> => {
  try {
    const tableCheck = await pgPool.query(
      `
      SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = $1
      )
      `,
      [tableName]
    );

    if (!tableCheck.rows[0].exists) {
      console.log(`Table ${tableName} does not exist, creating it...`);

      await pgPool.query(`
        CREATE TABLE ${tableName} (
            ticktime TIMESTAMP WITH TIME ZONE NOT NULL,
            lots INTEGER PRIMARY KEY,
            price NUMERIC NOT NULL
        )
      `);

      console.log(`Created table ${tableName}`);
    }
  } catch (error) {
    console.error(`Error ensuring table ${tableName} exists:`, error);
    throw error;
  }
};

export const ensureCandleTableExists = async (tableName: string): Promise<void> => {
  try {
    const tableCheck = await pgPool.query(
      `
      SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = $1
      )
      `,
      [tableName]
    );

    if (!tableCheck.rows[0].exists) {
      console.log(`Table ${tableName} does not exist, creating it...`);

      await pgPool.query(`
        CREATE TABLE ${tableName} (
            candlesize TEXT NOT NULL,
            lots SMALLINT NOT NULL,
            candletime TIMESTAMP WITH TIME ZONE NOT NULL,
            open NUMERIC(12,5) NOT NULL,
            high NUMERIC(12,5) NOT NULL,
            low NUMERIC(12,5) NOT NULL,
            close NUMERIC(12,5) NOT NULL,
            PRIMARY KEY (candlesize, lots, candletime)
        )
      `);

      console.log(`Created candle table ${tableName}`);
    }
  } catch (error) {
    console.error(`Error ensuring candle table ${tableName} exists:`, error);
    throw error;
  }
};

export const initCandleTables = async () => {
  try {
    const result = await pgPool.query("SELECT currpair FROM currpairdetails");
    const allCurrencyPairs = result.rows;

    console.log(
      `Initializing candle tables for ${allCurrencyPairs.length} currency pairs`
    );

    for (const pair of allCurrencyPairs) {
      const tableName = `candles_${pair.currpair.toLowerCase()}_bid`;
      await ensureCandleTableExists(tableName);
      console.log(`Candle table for ${pair.currpair} initialized`);
    }
  } catch (error) {
    console.error("Error initializing candle tables:", error);
  }
};

export const fetchAllCurrencyPairs = async () => {
  try {
    const result = await pgPool.query(
      "SELECT currpair, contractsize FROM currpairdetails"
    );
    availableCurrencyPairs = result.rows;

    console.log(
      `Fetched ${availableCurrencyPairs.length} currency pairs from database`
    );

    // Filter out pairs with null contract size
    const validPairs = availableCurrencyPairs.filter(
      (pair) => pair.contractsize !== null
    );
    const invalidPairs = availableCurrencyPairs.filter(
      (pair) => pair.contractsize === null
    );

    console.log(`${validPairs.length} pairs have valid contract size`);
    console.log(
      `${invalidPairs.length} pairs have null contract size and will not be subscribed`
    );

    if (invalidPairs.length > 0) {
      console.log(
        "Skipping subscription for the following pairs due to null contract size:"
      );
      invalidPairs.forEach((pair) => console.log(`- ${pair.currpair}`));
    }

    // Add valid pairs to subscribed set
    validPairs.forEach((pair) => {
      subscribedPairs.add(pair.currpair);
    });

    console.log("Subscribed pairs:", Array.from(subscribedPairs));

    for (const pair of validPairs) {
      await ensureTableExists(
        `ticks_${pair.currpair.toLowerCase()}_bid`,
        "BID"
      );
      await ensureTableExists(
        `ticks_${pair.currpair.toLowerCase()}_ask`,
        "ASK"
      );
    }
  } catch (error) {
    console.error("Error fetching currency pairs:", error);
  }
};

export const initDatabase = async () => {
  try {
    await fetchAllCurrencyPairs();
    await initCandleTables();

    console.log("Database tables initialized successfully");
  } catch (error) {
    console.error("Error initializing database tables:", error);
  }
};