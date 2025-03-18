// utils.ts
import { availableCurrencyPairs } from "../database/db.ts";
import { pgPool } from "../database/db.ts";

export const getContractSize = async (symbol: string): Promise<number> => {
  try {
    const pairInfo = availableCurrencyPairs.find(
      (pair) => pair.currpair === symbol
    );

    if (pairInfo && pairInfo.contractsize !== null) {
      return parseFloat(pairInfo.contractsize.toString());
    } else {
      console.warn(
        `Warning: Received data for ${symbol} which has no contract size or wasn't subscribed`
      );

      // Try to get the contract size directly from the database as a fallback
      try {
        const result = await pgPool.query(
          "SELECT contractsize FROM currpairdetails WHERE currpair = $1",
          [symbol]
        );

        if (result.rows.length > 0 && result.rows[0].contractsize !== null) {
          console.log(
            `Found contract size in database: ${result.rows[0].contractsize} for ${symbol}`
          );
          return parseFloat(result.rows[0].contractsize.toString());
        }
      } catch (dbError) {
        console.error(`Database lookup for contract size failed:`, dbError);
      }

      throw new Error(
        `Cannot process data for ${symbol}: No valid contract size found`
      );
    }
  } catch (error) {
    console.error(`Error getting contract size for ${symbol}:`, error);
    throw new Error(`Cannot process market data: ${error.message}`);
  }
};

export const calculateLots = (quantity: number, contractSize: number): number => {
  console.log(
    `Calculating lots: ${quantity} / ${contractSize} = ${Math.round(
      quantity / contractSize
    )}`
  );
  return Math.round(quantity / contractSize);
};