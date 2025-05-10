import { WebSocket, WebSocketServer } from "ws"
import pkg from "pg"
const { Pool } = pkg
import { configDotenv } from "dotenv"
import { v4 as uuidv4 } from "uuid"
import marketLogger, { marketLoggerLot1 } from "./logger"
import { FixMarket } from "./FixMarket"
import type { ParsedFixMessage } from "./Fix"
import Redis from "ioredis"

configDotenv()

const FIX_SERVER = process.env.FIX_SERVER_WITHOUT_SSL_MD
const FIX_PORT = process.env.FIX_PORT_WITHOUT_SSL_MD
const SENDER_COMP_ID = process.env.SENDER_COMP_ID_WITHOUT_SSL_MD
const TARGET_COMP_ID = process.env.TARGET_COMP_ID_WITHOUT_SSL_MD
const USERNAME = process.env.USERNAME_WITHOUT_SSL_MD
const PASSWORD = process.env.PASSWORD_WITHOUT_SSL_MD

const PG_HOST = process.env.PG_HOST_WITHOUT_SSL_MD
const PG_PORT = process.env.PG_PORT_WITHOUT_SSL_MD
const PG_USER = process.env.PG_USER_WITHOUT_SSL_MD
const PG_PASSWORD = process.env.PG_PASSWORD_WITHOUT_SSL_MD
const PG_DATABASE = process.env.PG_DATABASE_WITHOUT_SSL_MD

const WS_PORT = process.env.PRODUCTION_PORT_WS

if (!FIX_SERVER || !FIX_PORT || !SENDER_COMP_ID || !TARGET_COMP_ID || !USERNAME || !PASSWORD) {
  marketLogger.debug("One or more variable is missing")
}

const wss = new WebSocketServer({ port: Number(WS_PORT) || 8081 })
marketLogger.info(`WebSocket server is running on ws://192.168.18.197:${WS_PORT || 8081}`)

const redisClient = new Redis({
  host: process.env.REDIS_HOST || '3.82.229.23',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: Number(process.env.REDIS_DB),
  retryStrategy: (times) => {
    const delay = Math.min(times * 100, 5000);
    return delay;
  },
  maxRetriesPerRequest: 3
});

redisClient.on('connect', () => {
  marketLogger.info("Connected to Redis")
  // console.log("Connected to Redis");
})

redisClient.on('error', (error) => {
  marketLogger.info("Redis Error", error.message)
  // console.log("Redis Error", error.message);
})

const wsClients = new Map()

const MD_ENTRY_TYPES = {
  "0": "BID",
  "1": "ASK",
  "2": "TRADE",
  "3": "INDEX_VALUE",
  "4": "OPENING_PRICE",
  "5": "CLOSING_PRICE",
  "6": "SETTLEMENT_PRICE",
  "7": "TRADING_SESSION_HIGH_PRICE",
  "8": "TRADING_SESSION_LOW_PRICE",
}

interface MarketDataMessage {
  symbol: string
  type: "BID" | "ASK"
  price: number
  quantity: number
  timestamp: string
  rawData: Record<string, string>
}

interface TickData {
  symbol: string
  price: number
  timestamp: Date
  lots: number
}

interface CurrencyPairInfo {
  currpair: string
  contractsize: number | null
  contract_currency: string | null
  contract_multiplier: number | null
  currpairtype: string | null
}

interface WebSocketClient {
  currencyPairs: string[]
  subscribedAll: boolean
  isSinglePairSub: boolean
}

interface WebSocketResponse {
  action: string
  status: string
  subs?: string[]
  message?: string
}

const pgPool = new Pool({
  host: PG_HOST,
  port: PG_PORT ? Number(PG_PORT) : 5432,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
})

let availableCurrencyPairs: CurrencyPairInfo[] = []
const subscribedPairs = new Set()

async function getExchangeRate(currency: string): Promise<number> {
  if (currency === 'USD') return 1;

  try {
    let rate = await redisClient.get(`laravel_database_CP_${currency}USD_1_B`);
    let rateType = 'Bid';

    if (!rate) {
      rate = await redisClient.get(`laravel_database_CP_${currency}USD_1_A`);
      rateType = 'Ask';
    }

    if (!rate) {
      rate = await redisClient.get(`laravel_database_CP_USD${currency}_1_B`);
      rateType = 'Bid';
    }

    if (!rate) {
      rate = await redisClient.get(`laravel_database_CP_USD${currency}_1_A`);
      rateType = 'Ask';
    }

    if (!rate) {
      throw new Error(`Exchange rate not found for ${currency}USD or USD${currency} (tried both Bid and Ask)`);
    }

    const rateValue = parseFloat(rate);
    marketLogger.debug(`Using ${rateType} rate for ${currency}USD: ${rateValue}`);

    return rateValue;
  } catch (error) {
    marketLogger.error(`Error getting exchange rate for ${currency}USD`, error);
    throw error;
  }
}

const getContractSizeForRedis = async (symbol: string, currentPrice: number): Promise<number> => {
  try {
    const pairInfo = availableCurrencyPairs.find((pair) => pair.currpair === symbol);

    if (!pairInfo) {
      throw new Error(`Currency pair not found: ${symbol}`);
    }

    let contractSize: number;

    if (pairInfo.currpairtype === 'FOREX' || pairInfo.currpairtype === 'CRYPTO') {
      if (pairInfo.contractsize === null) {
        // console.log(`Contract size missing for ${pairInfo.currpairtype} pair ${symbol}`);
        throw new Error(`Contract size missing for ${pairInfo.currpairtype} pair ${symbol}`);
      }
      contractSize = Number(pairInfo.contractsize);
    } else {
      if (!pairInfo.contract_currency || pairInfo.contract_multiplier === null) {
        throw new Error(`Missing calculation parameters for ${symbol}`);
      }
      const exchangeRate = await getExchangeRate(pairInfo.contract_currency);
      contractSize = currentPrice * pairInfo.contract_multiplier * exchangeRate;
    }

    await redisClient.set(`${process.env.REDIS_PREFIX}CS_${symbol}`, contractSize.toString());
    marketLogger.debug(`Stored contract size in Redis for ${symbol}: ${contractSize} (${pairInfo.currpairtype})`);
    return contractSize;
  } catch (error) {
    marketLogger.error(`Contract size error for ${symbol}`, error);
    throw error;
  }
};

const getContractSizeForLots = (symbol: string, size: number): number => {
  try {
    const pairInfo = availableCurrencyPairs.find((pair) => pair.currpair === symbol);

    if (!pairInfo) {
      throw new Error(`Currency pair not found: ${symbol}`);
    }

    if (pairInfo.currpairtype !== 'FOREX' && pairInfo.currpairtype !== 'CRYPTO') {
      return size;
    }

    if (pairInfo.contractsize === null) {
      throw new Error(`Contract size missing for pair ${symbol}`);
    }

    return Number(pairInfo.contractsize);
  } catch (error) {
    marketLogger.error(`Contract size error for ${symbol}`, error);
    throw error;
  }
};

const broadcastTickData = async (
  currencyPair: string,
  price: number,
  lots: number,
  timestamp: number,
  type: "BID" | "ASK",
) => {

  const isValidLotSize = [1, 5, 10, 30, 50].includes(lots);
  const isSingleLotBid = type === "BID" && lots === 1;

  if (!isValidLotSize && !isSingleLotBid) return;

  const tickData = {
    symbol: currencyPair,
    p: price,
    ts: timestamp,
    lots,
    bora: type === "BID" ? "B" : "A",
  };

  wsClients.forEach((clientData, ws) => {

    const isSubscribed = clientData.currencyPairs.includes(currencyPair) || clientData.subscribedAll;

    if (!isSubscribed || ws.readyState !== WebSocket.OPEN) return;

    if (clientData.isSinglePairSub) {
      if (isSingleLotBid) {
        ws.send(JSON.stringify(tickData));
      }
    } else if (isValidLotSize) {
      ws.send(JSON.stringify(tickData));
    }
  });
};

const calculateLots = (quantity: number, contractSize: number): number => {
  return Math.round(quantity / contractSize)
}

const initCurrencyPairs = async () => {
  try {
    await fetchAllCurrencyPairs()
  } catch (error) {
    marketLogger.error("Error fetching Currency Pairs", error)
  }
}

const fetchAllCurrencyPairs = async () => {
  try {
    const result = await pgPool.query(`
      SELECT 
        cpd.currpair, 
        cpd.contractsize,
        cpd.contract_currency,
        cpd.contract_multiplier,
        cp.currpairtype
      FROM currpairdetails cpd
      JOIN currpairs cp ON cpd.currpair = cp.currpair
      WHERE cp.currpairtype = 'FOREX'
    `);

    availableCurrencyPairs = result.rows;


    const validPairs = availableCurrencyPairs.filter((pair) => pair.contractsize !== null);

    validPairs.forEach((pair) => {
      subscribedPairs.add(pair.currpair);
      // console.log(pair.currpair);
      marketLogger.debug(`Subscribed to ${pair.currpair} (${pair.currpairtype})`);
    });

    marketLogger.info(`Loaded ${validPairs.length} valid currency pairs`);
    return true;
  } catch (error) {
    marketLogger.error("Failed to fetch currency pairs", error);
    return false;
  }
}
const oldPrices: Record<string, number> = {};

class MarketDataHandler {
  private fixClient: FixMarket
  private subscribedPairs: Set<string>
  private isInitialized: boolean

  constructor() {
    if (!SENDER_COMP_ID || !TARGET_COMP_ID || !USERNAME || !PASSWORD) {
      throw new Error("Missing required FIX credentials")
    }

    this.fixClient = new FixMarket(SENDER_COMP_ID, TARGET_COMP_ID, USERNAME, PASSWORD)
    this.subscribedPairs = new Set()
    this.isInitialized = false

    this.setupFixClientCallbacks()
  }

  private setupFixClientCallbacks() {
    this.fixClient.onMessage = (parsed, rawMessage) => this.handleFixMessage(parsed, rawMessage)
    this.fixClient.onResubscribe = () => this.subscribeToMarketData()
  }

  private async handleFixMessage(parsed: ParsedFixMessage, rawMessage: string) {
    marketLogger.info(`Received FIX message: ${rawMessage}`)

    if (parsed.messageType === "Logon") {
      marketLogger.info("Logon response received, authentication successful")
      // console.log("Logon response received, authentication successful")
      setTimeout(() => {
        this.subscribeToMarketData()
      }, 500)
    } else if (parsed.messageType === "Heartbeat") {
      marketLogger.info("Received heartbeat from server")
      // console.log("Received heartbeat from server")
    } else if (parsed.messageType === "Logout") {
      marketLogger.info("Received logout from server")
      // console.log("Received logout from server")
    } else if (
      parsed.messageType === "Market Data Snapshot" ||
      parsed.messageType === "Market Data Incremental Refresh"
    ) {
      marketLogger.info("Received market data response!")

      try {

        const noMDEntries = Number.parseInt(parsed.additionalFields["268"] || "0")
        const symbol = parsed.additionalFields["55"] || ""

        if (noMDEntries > 0 && symbol) {
          const rawFields = rawMessage.split("\u0001");

          const mdEntries = []
          let currentEntry: Record<string, string> = {}
          let inEntry = false

          for (const field of rawFields) {
            const [tag, value] = field.split("=")
            if (!tag || !value) continue

            if (tag === "269") {
              if (inEntry && Object.keys(currentEntry).length > 0) {
                mdEntries.push(currentEntry)
              }
              currentEntry = {}
              inEntry = true
            }

            if (inEntry) {
              if (["269", "270", "271", "273"].includes(tag)) {
                currentEntry[tag] = value
              }
            }
          }

          if (inEntry && Object.keys(currentEntry).length > 0) {
            mdEntries.push(currentEntry)
          }

          const lot1log: string[] = [];

          for (let i = 0; i < mdEntries.length; i++) {
            const entry = mdEntries[i]

            if (entry["269"] && entry["270"]) {
              const entryType = entry["269"]
              const price = Number.parseFloat(entry["270"])
              const size = Number.parseFloat(entry["271"] || "0")

              if (["0", "1"].includes(entryType)) {
                const type = MD_ENTRY_TYPES[entryType as keyof typeof MD_ENTRY_TYPES] || "UNKNOWN"

                getContractSizeForRedis(symbol, price);

                const contractSizeForLots = getContractSizeForLots(symbol, size);

                const lots = Math.round(size / contractSizeForLots);

                const bora = type === "BID" ? "B" : "A"
                const timestamp = new Date().getTime()

                const payload = `${symbol} ${lots} ${bora} ${price} ${timestamp}`
                const oPriceKey = `${symbol}_${lots}_${bora}`;

                availableCurrencyPairs.find((pair) => pair.currpair === symbol)?.currpairtype === "FOREX" && lots == 1 && lot1log.push(payload);

                const oPrice = oldPrices[oPriceKey] || 0;
                if (oPrice !== price) {
                  try {
                    const query = `NOTIFY tick, '${payload}'`
                    pgPool.query(query)
                    // try {
                    //    redisClient.publish('tick', payload);
                    //   marketLogger.info(`Published to Redis channel 'tick': ${payload}`);
                    // } catch (redisError) {
                    //   marketLogger.error("Error publishing to Redis:", redisError);
                    //   console.error("Error publishing to Redis:", redisError);
                    // }

                  } catch (error) {
                    console.error("Error sending PostgreSQL notification", error)
                  }
                  broadcastTickData(symbol, price, lots, timestamp, type as "BID" | "ASK")
                  oldPrices[oPriceKey] = price;
                }

              }
            }
          }

          if (lot1log.length > 0) {
            marketLoggerLot1.info("===================================================================")
            for (const element of lot1log) {
              marketLoggerLot1.info(element);
            }
            marketLoggerLot1.info(rawMessage);
            marketLoggerLot1.info("===================================================================")
          }
        }
      } catch (error) {
        marketLogger.error("Error processing market data:", error)
        console.error("Error processing market data:", error)
      }
    } else if (parsed.messageType === "Reject") {
      marketLogger.error("Request rejected by server:", parsed.additionalFields["58"] || "Unknown reason")
      console.error("Request rejected by server:", parsed.additionalFields["58"] || "Unknown reason")
    }
  }

  public async connect() {
    if (!this.isInitialized) {
      await initCurrencyPairs()
      this.isInitialized = true
    }

    if (FIX_SERVER && FIX_PORT) {
      this.fixClient.connect(FIX_SERVER, Number(FIX_PORT))
    } else {
      marketLogger.error("FIX_SERVER or FIX_PORT not defined")
      throw new Error("FIX_SERVER or FIX_PORT not defined")
    }
  }

  subscribeToMarketData() {
    if (!this.fixClient.isConnected) {
      marketLogger.info("Not connected to FIX server. Cannot subscribe to market data.")
      // console.log("Not connected to FIX server. Cannot subscribe to market data.")
      return
    }

    const pairsToSubscribe = availableCurrencyPairs.filter((pair) => subscribedPairs.has(pair.currpair))

    for (const pair of pairsToSubscribe) {
      this.fixClient.sequenceNumber++

      const uniqueId = uuidv4()
      const mdReqId = `MDR_${uniqueId}`

      const messageBody = [
        "35=V",
        `49=${this.fixClient.senderCompId}`,
        `56=${this.fixClient.targetCompId}`,
        `34=${this.fixClient.sequenceNumber}`,
        `52=${this.fixClient.getUTCTimestamp()}`,
        `262=${mdReqId}`,
        "263=1",
        "264=0",
        "267=2",
        "269=0",
        "269=1",
        "146=1",
        `55=${pair.currpair}`,
      ].join("\u0001")

      const bodyLength = messageBody.length
      let fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`

      const checksum = this.fixClient.calculateChecksum(fullMessage + "\u0001")
      fullMessage = `${fullMessage}\u000110=${checksum}\u0001`

      if (this.fixClient.client) {
        this.fixClient.client.write(fullMessage)
      }

      if (pairsToSubscribe.indexOf(pair) < pairsToSubscribe.length - 1) {
        setTimeout(() => { }, 200)
      }
    }
  }

  public disconnect() {
    this.fixClient.disconnect()
  }
}

wss.on("connection", (ws) => {
  marketLogger.info("Client connected")

  const clientData: WebSocketClient = {
    currencyPairs: [],
    subscribedAll: false,
    isSinglePairSub: false,
  }

  wsClients.set(ws, clientData)

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString())
      marketLogger.info("Received message", data)

      const response: WebSocketResponse = {
        action: data.action,
        status: "success",
      }

      if (data.action === "SubAdd") {
        clientData.isSinglePairSub = true
        clientData.subscribedAll = false

        if (data.subs && Array.isArray(data.subs)) {
          const pairsToSubscribe = data.subs
            .map((sub: string) => sub.split("~")[1])

          pairsToSubscribe.forEach((pair: string) => {
            if (!clientData.currencyPairs.includes(pair)) {
              clientData.currencyPairs.push(pair)
            }
          })

          response.subs = pairsToSubscribe.map((pair: any) => `0~${pair}`)
        }
      } else if (data.action === "SubAddAll") {
        clientData.isSinglePairSub = false
        clientData.subscribedAll = true
        clientData.currencyPairs = availableCurrencyPairs.map((pair) => pair.currpair)
        response.subs = clientData.currencyPairs.map((pair) => `0~${pair}`)
      } else if (data.action === "SubRemove") {
        if (data.subs && Array.isArray(data.subs)) {
          data.subs.forEach((sub: string) => {
            const pair = sub.split("~")[1]
            const index = clientData.currencyPairs.indexOf(pair)
            if (index !== -1) {
              clientData.currencyPairs.splice(index, 1)
            }
          })
          response.subs = data.subs
        }
      }

      ws.send(JSON.stringify(response))
    } catch (error) {
      marketLogger.error("Error processing message", error)
      ws.send(
        JSON.stringify({
          action: "error",
          status: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      )
    }
  })

  ws.on("close", () => {
    marketLogger.info("Client disconnected")
    wsClients.delete(ws)
  })

  ws.on("error", (error) => {
    marketLogger.error("WebSocket error", error)
    wsClients.delete(ws)
  })
})

const marketDataHandler = new MarketDataHandler()

process.on("SIGINT", async () => {
  marketLogger.info("Shutting down...")
  marketDataHandler.disconnect()

  // console.log("Closing WebSocket server...")
  marketLogger.info("Closing WebSocket server...")
  wss.close()

  marketLogger.info("Closing database connection...")
  // console.log("Closing database connection...")

  pgPool.end().then(() => {
    marketLogger.info("Database connection closed")
    // console.log("Database connection closed")
    process.exit(0)
  })
})

export default MarketDataHandler