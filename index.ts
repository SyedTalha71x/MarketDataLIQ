import { Socket } from "net";
import { WebSocket, WebSocketServer } from "ws";
import pkg from "pg";
const { Pool } = pkg;
import { configDotenv } from "dotenv";

configDotenv();

const FIX_SERVER = process.env.FIX_SERVER;
const FIX_PORT = process.env.FIX_PORT;
const SENDER_COMP_ID = process.env.SENDER_COMP_ID;
const TARGET_COMP_ID = process.env.TARGET_COMP_ID;
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

const PG_HOST = process.env.PG_HOST;
const PG_PORT = process.env.PG_PORT;
const PG_USER = process.env.PG_USER;
const PG_PASSWORD = process.env.PG_PASSWORD;
const PG_DATABASE = process.env.PG_DATABASE;

const WS_PORT = process.env.WS_PORT || 8080;

if (
  !FIX_SERVER ||
  !FIX_PORT ||
  !SENDER_COMP_ID ||
  !TARGET_COMP_ID ||
  !USERNAME ||
  !PASSWORD
) {
  console.log(
    "One or more required environment variables are missing, using sample mode."
  );
}

const wss = new WebSocketServer({ port: Number(WS_PORT) || 8080 });
console.log(`WebSocket server is running on ws://50.19.20.84:${WS_PORT || 8080}`);

const wsClients = new Map();

const timeFrames = {
  M1: 60000, // 1 minute (60000 ms)
  H1: 3600000, // 1 hour (3600000 ms)
  D1: 86400000, // 1 day (86400000 ms)
};

const MESSAGE_TYPES = {
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
};

// Define interfaces for type safety
interface MarketDataMessage {
  symbol: string;
  type: "BID" | "ASK";
  price: number;
  quantity: number;
  timestamp: string;
  rawData: Record<string, string>;
}

interface TickData {
  symbol: string;
  price: number;
  timestamp: Date;
  lots: number;
}

interface ParsedFixMessage {
  messageType: string;
  senderCompId: string;
  targetCompId: string;
  msgSeqNum: number;
  sendingTime: string;
  rawMessage: string;
  testReqId?: string;
  username?: string;
  additionalFields: Record<string, string>;
}

interface CurrencyPairInfo {
  currpair: string;
  contractsize: number | null;
}

interface WebSocketClient {
  currencyPairs: string[];
  fsyms: string[];
  tsyms: string[];
}

// Initialize PostgreSQL connection for fetching currency pairs only
const pgPool = new Pool({
  host: PG_HOST,
  port: PG_PORT ? Number(PG_PORT) : 5432,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
});

let sequenceNumber = 0;
let isConnected = false;
let reconnectTimeout = null;

// Handle WebSocket connections
wss.on("connection", (ws) => {
  console.log("New WebSocket client connected");

  // Initialize client data
  const clientData = {
    currencyPairs: [],
    fsyms: [],
    tsyms: [],
  };

  wsClients.set(ws, clientData);

  // Handle client messages
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("WebSocket message received:", data);

      if (data.action === "SubAdd") {
        // Subscribe to currency pairs
        if (data.subs && Array.isArray(data.subs)) {
          data.subs.forEach((sub) => {
            const fields = sub.split("~");
            const fsym = fields[fields.length - 2];
            const tsym = fields[fields.length - 1];
            const currPair = fsym + tsym;

            clientData.currencyPairs.push(currPair);
            clientData.fsyms.push(fsym);
            clientData.tsyms.push(tsym);
          });

          console.log(
            `Client subscribed to: ${clientData.currencyPairs.join(", ")}`
          );
        }
      } else if (data.action === "SubRemove") {
        // Unsubscribe from currency pairs
        if (data.subs && Array.isArray(data.subs)) {
          data.subs.forEach((sub) => {
            const fields = sub.split("~");
            const fsym = fields[fields.length - 2];
            const tsym = fields[fields.length - 1];
            const currPair = fsym + tsym;

            const index = clientData.currencyPairs.indexOf(currPair);
            if (index !== -1) {
              clientData.currencyPairs.splice(index, 1);
              clientData.fsyms.splice(index, 1);
              clientData.tsyms.splice(index, 1);
            }
          });

          console.log(
            `Client unsubscribed from pairs. Remaining subscriptions: ${clientData.currencyPairs.join(
              ", "
            )}`
          );
        }
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    wsClients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket client error:", error);
    wsClients.delete(ws);
  });
});

const broadcastTickData = (currencyPair, price, timestamp, lotSize, type) => {
  const bora = type === 'BID' ? 'B' : 'A';
  const tickEpoch = Math.floor(timestamp.getTime() / 1000);
  
  if (currencyPair === 'DJIUSD') {
    console.log(`DJIUSD tick ${currencyPair} ${lotSize} ${bora} ${price} ${tickEpoch}`);
  }
  
  // Broadcast to all WebSocket clients that are subscribed to this currency pair
  wsClients.forEach((clientData, ws) => {
    const index = clientData.currencyPairs.indexOf(currencyPair);
    
    if (index !== -1) {
      const fsym = clientData.fsyms[index];
      const tsym = clientData.tsyms[index];
      
      const tickData = {
        currpair: currencyPair,  // Add the currency pair directly
        fsym: fsym,
        tsym: tsym,
        price: price,           // Change p to price to match frontend expectations
        lots: lotSize,
        bora: bora,
        ts: tickEpoch
      };
      
      const jsonData = JSON.stringify(tickData);
      console.log(`Broadcasting to client: ${jsonData}`);
      
      // Send to client if connection is open
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(jsonData);
      }
    }
  });
};

// Helper functions
const getUTCTimestamp = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getUTCDate()).padStart(2, "0")}-${String(
    now.getUTCHours()
  ).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(
    now.getUTCSeconds()
  ).padStart(2, "0")}.${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
};

const calculateChecksum = (message) => {
  let sum = 0;
  for (let i = 0; i < message.length; i++) {
    sum += message.charCodeAt(i);
  }
  return (sum % 256).toString().padStart(3, "0");
};

const calculateLots = (quantity, contractSize) => {
  console.log(
    `Calculating lots: ${quantity} / ${contractSize} = ${Math.round(
      quantity / contractSize
    )}`
  );
  return Math.round(quantity / contractSize);
};

// Store available currency pairs
let availableCurrencyPairs = [];

// Track subscribed currency pairs
const subscribedPairs = new Set();

// Initialize and fetch currency pairs from database
const initCurrencyPairs = async () => {
  try {
    await fetchAllCurrencyPairs();
    console.log("Currency pairs fetched successfully");
  } catch (error) {
    console.error("Error fetching currency pairs:", error);
  }
};

const fetchAllCurrencyPairs = async () => {
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
    return true;
  } catch (error) {
    console.error("Error fetching currency pairs:", error);
    return false;
  }
};

const getContractSize = (symbol) => {
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
      return 100000; // Default contract size as fallback
    }
  } catch (error) {
    console.error(`Error getting contract size for ${symbol}:`, error);
    return 100000; // Default contract size as fallback
  }
};

const createFixMessage = (body) => {
  sequenceNumber += 1;

  const messageBody = [
    `35=${body[35]}`,
    `49=${SENDER_COMP_ID}`,
    `56=${TARGET_COMP_ID}`,
    `34=${sequenceNumber}`,
    `52=${getUTCTimestamp()}`,
    ...Object.entries(body)
      .filter(([key]) => !["35"].includes(key))
      .map(([key, value]) => `${key}=${value}`),
  ].join("\u0001");

  const bodyLength = messageBody.length;
  let fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`;
  const checksum = calculateChecksum(fullMessage + "\u0001");
  return `${fullMessage}\u000110=${checksum}\u0001`;
};

class FixClient {
  private client: Socket | null;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 1000;
  private readonly reconnectDelay: number = 5000;
  private buffer: string = "";
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.client = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 1000;
    this.reconnectDelay = 5000;
    this.buffer = "";
    this.heartbeatInterval = null;
    
    this.initializeClient();
    
    // Initialize currency pairs
    initCurrencyPairs().catch((err) => {
      console.error("Failed to initialize currency pairs:", err);
    });
  }

  initializeClient() {
    this.client = new Socket();
    this.client.setKeepAlive(true, 30000);
    this.client.setNoDelay(true);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on("connect", this.handleConnect.bind(this));
    this.client.on("data", this.handleData.bind(this));
    this.client.on("error", this.handleError.bind(this));
    this.client.on("close", this.handleClose.bind(this));
    this.client.on("end", this.handleEnd.bind(this));
  }

  setupHeartbeat() {
    // Clear any existing heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Set up a new heartbeat interval to send heartbeats every 20 seconds
    this.heartbeatInterval = setInterval(() => {
      if (isConnected) {
        const heartbeatMessage = createFixMessage({
          35: "0", 
        });
        this.client.write(heartbeatMessage);
        console.log("Sent heartbeat to server");
      }
    }, 20000);
  }

  parseFixMessage(message) {
    const fields = message.split("\u0001");
    const fieldMap = {};

    // Parse all fields into key-value pairs
    fields.forEach((field) => {
      const [key, value] = field.split("=");
      if (key && value) {
        fieldMap[key] = value;
      }
    });

    // Extract common fields
    const messageType = fieldMap["35"];
    const readableType = MESSAGE_TYPES[messageType] || `Unknown (${messageType})`;

    const parsed: ParsedFixMessage = {
      messageType: readableType,
      senderCompId: fieldMap["49"] || "",
      targetCompId: fieldMap["56"] || "",
      msgSeqNum: parseInt(fieldMap["34"] || "0"),
      sendingTime: fieldMap["52"] || "",
      rawMessage: message,
      additionalFields: {},
    };

    // Add optional fields if present
    if (fieldMap["112"]) parsed.testReqId = fieldMap["112"];
    if (fieldMap["553"]) parsed.username = fieldMap["553"];

    // Add any other fields to additionalFields
    Object.entries(fieldMap).forEach(([key, value]) => {
      if (
        !["8", "9", "35", "49", "56", "34", "52", "10", "112", "553"].includes(
          key
        )
      ) {
        parsed.additionalFields[key] = value as string;
      }
    });

    return parsed;
  }

  logParsedMessage(parsed, direction) {
    const timestamp = new Date().toISOString();
    console.log("\n" + "=".repeat(80));
    console.log(`${direction} at ${timestamp}`);
    console.log("-".repeat(80));
    console.log(`Message Type: ${parsed.messageType}`);
    console.log(`From: ${parsed.senderCompId}`);
    console.log(`To: ${parsed.targetCompId}`);
    console.log(`Sequence: ${parsed.msgSeqNum}`);
    console.log(`Time: ${parsed.sendingTime}`);

    if (parsed.testReqId) {
      console.log(`Test Request ID: ${parsed.testReqId}`);
    }

    if (Object.keys(parsed.additionalFields).length > 0) {
      console.log("\nAdditional Fields:");
      Object.entries(parsed.additionalFields).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
    }
    console.log("=".repeat(80) + "\n");
  }

  handleConnect() {
    console.log("Connected to FIX server");
    this.sendLogon();
  }

  sendLogon() {
    isConnected = true;
    this.reconnectAttempts = 0;
    this.buffer = "";

    const logonMessage = createFixMessage({
      35: "A",
      98: 0,
      108: 30,
      553: USERNAME || "",
      554: PASSWORD || "",
      141: "Y",
    });

    this.client.write(logonMessage);
    const parsed = this.parseFixMessage(logonMessage);
    console.log("Logon sent");
    this.logParsedMessage(parsed, "Sent");
    
    // Set up heartbeat after logon
    this.setupHeartbeat();
  }

  handleTestRequest(testReqId) {
    // Respond to test request with a heartbeat message
    const heartbeatMessage = createFixMessage({
      35: "0", // Heartbeat
      112: testReqId, // Echo back the TestReqID
    });
    
    this.client.write(heartbeatMessage);
    console.log(`Responded to test request with heartbeat, TestReqID: ${testReqId}`);
  }

  handleData(data) {
    // Append the new data to our buffer
    this.buffer += data.toString();

    // Process any complete FIX messages in the buffer
    const messages = this.extractMessages();

    for (const message of messages) {
      console.log("RAW MESSAGE RECEIVED:", message);

      const parsed = this.parseFixMessage(message);
      this.logParsedMessage(parsed, "Received");

      // Handle test request message
      if (parsed.messageType === "Test Request" && parsed.testReqId) {
        this.handleTestRequest(parsed.testReqId);
      }

      // Process market data messages
      if (
        parsed.messageType === "Market Data Snapshot" ||
        parsed.messageType === "Market Data Incremental Refresh"
      ) {
        console.log("Received market data response!");

        try {
          // Extract market data entries
          const noMDEntries = parseInt(parsed.additionalFields["268"] || "0");
          const symbol = parsed.additionalFields["55"] || "";

          console.log(
            `Got market data for symbol: ${symbol}, entries: ${noMDEntries}`
          );

          if (noMDEntries > 0 && symbol) {
            // Process all incoming data regardless of subscription status
            console.log(
              `Processing ${noMDEntries} market data entries for ${symbol}`
            );

            // Extract all fields directly from the raw message
            const rawFields = message.split("\u0001");
            const fieldMap = {};

            rawFields.forEach((field) => {
              const [tag, value] = field.split("=");
              if (tag && value) {
                fieldMap[tag] = value;
              }
            });

            // Find all repeating group entries in the original message
            const mdEntries = [];
            let currentEntry = {};
            let inEntry = false;

            // Process the fields in order
            for (const field of rawFields) {
              const [tag, value] = field.split("=");
              if (!tag || !value) continue;

              // Check if this is the beginning of a new entry (MDEntryType)
              if (tag === "269") {
                if (inEntry && Object.keys(currentEntry).length > 0) {
                  // Save the previous entry
                  mdEntries.push(currentEntry);
                }
                // Start a new entry
                currentEntry = {};
                inEntry = true;
              }

              // If we're in an entry, collect its fields
              if (inEntry) {
                if (["269", "270", "271", "273"].includes(tag)) {
                  currentEntry[tag] = value;
                }
              }
            }

            // Add the last entry if it exists
            if (inEntry && Object.keys(currentEntry).length > 0) {
              mdEntries.push(currentEntry);
            }

            console.log(`Extracted ${mdEntries.length} market data entries`);

            // Process each entry
            for (let i = 0; i < mdEntries.length; i++) {
              const entry = mdEntries[i];
              console.log(
                `Entry ${i + 1} - Type: ${entry["269"]}, Price: ${
                  entry["270"]
                }, Size: ${entry["271"]}`
              );

              if (entry["269"] && entry["270"]) {
                const entryType = entry["269"];
                const price = parseFloat(entry["270"]);
                const size = parseFloat(entry["271"] || "0");
                const time = entry["273"] || "";

                if (["0", "1"].includes(entryType)) {
                  // BID or ASK
                  const type = MD_ENTRY_TYPES[entryType];

                  console.log(
                    `Found ${type} entry for ${symbol}: Price=${price}, Size=${size}`
                  );

                  // Get contract size for calculating lots
                  const contractSize = getContractSize(symbol);
                  const lots = calculateLots(size, contractSize);

                  // Broadcast data to websocket clients directly
                  broadcastTickData(symbol, price, new Date(), lots, type);
                  
                  console.log(
                    `Broadcasted ${type} data for ${symbol}: Price=${price}, Lots=${lots}`
                  );
                }
              }
            }
          } else {
            console.log(
              `No market data entries found for ${symbol || "unknown symbol"}`
            );
          }
        } catch (error) {
          console.error("Error processing market data:", error);
        }
      } else if (parsed.messageType === "Reject") {
        console.error(
          "Request rejected by server:",
          parsed.additionalFields["58"] || "Unknown reason"
        );
      } else if (parsed.messageType === "Logon") {
        console.log("Logon response received, authentication successful");
        // Subscribe after successful logon with a small delay
        setTimeout(() => {
          this.subscribeToMarketData();
        }, 1000);
      } else if (parsed.messageType === "Heartbeat") {
        console.log("Received heartbeat from server");
      } else if (parsed.messageType === "Logout") {
        console.log("Received logout from server");
        isConnected = false;
        this.reconnect();
      } else {
        console.log(`Received message of type: ${parsed.messageType}`);
      }
    }
  }

  // Extract complete FIX messages from the buffer
  extractMessages() {
    const messages = [];
    const delimiter = "\u000110=";
    let position = 0;

    while (true) {
      const start = this.buffer.indexOf("8=FIX", position);
      if (start === -1) break;

      const end = this.buffer.indexOf(delimiter, start);
      if (end === -1) break;

      // Find the end of the checksum (3 more characters after the delimiter)
      const checksumEnd = end + delimiter.length + 3;
      if (checksumEnd > this.buffer.length) break;

      // Extract the complete message including the checksum
      const message = this.buffer.substring(start, checksumEnd + 1);
      messages.push(message);

      // Move position past this message
      position = checksumEnd + 1;
    }

    // Remove processed messages from the buffer
    if (position > 0) {
      this.buffer = this.buffer.substring(position);
    }

    return messages;
  }

  handleError(err) {
    console.log("Socket error:", err.message);
    if (isConnected) {
      isConnected = false;
    }

    this.reconnect();
  }

  handleClose(hadError) {
    console.log("Connection closed", hadError ? "due to error" : "normally");
    isConnected = false;
    this.cleanupConnection();
    this.reconnect();
  }

  handleEnd() {
    console.log("Connection ended");
    isConnected = false;
    this.cleanupConnection();
    this.reconnect();
  }

  cleanupConnection() {
    // Clean up heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  reconnect() {
    if (reconnectTimeout !== null) {
      clearTimeout(reconnectTimeout);
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`
      );

      reconnectTimeout = setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    } else {
      console.log(
        `Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`
      );
    }
  }

  connect() {
    try {
      console.log(`Connecting to FIX server at ${FIX_SERVER}:${FIX_PORT}...`);
      this.client.connect(Number(FIX_PORT), FIX_SERVER);
    } catch (error) {
      console.error("Error connecting to FIX server:", error);
      this.reconnect();
    }
  }

  subscribeToMarketData() {
    if (!isConnected) {
      console.log(
        "Not connected to FIX server. Cannot subscribe to market data."
      );
      return;
    }

    console.log("Subscribing to market data for currency pairs...");

    // Get only pairs that are in the subscribedPairs set (already filtered for null contract size)
    const pairsToSubscribe = availableCurrencyPairs.filter((pair) =>
      subscribedPairs.has(pair.currpair)
    );

    console.log(`Found ${pairsToSubscribe.length} valid pairs to subscribe`);

    for (const pair of pairsToSubscribe) {
      console.log(
        `Subscribing to market data for ${pair.currpair} with contract size ${pair.contractsize}`
      );

      // Construct the FIX message manually to handle repeating groups correctly
      sequenceNumber++;

      const messageBody = [
        "35=V", // Message Type (V = Market Data Request)
        `49=${SENDER_COMP_ID}`, // SenderCompID
        `56=${TARGET_COMP_ID}`, // TargetCompID
        `34=${sequenceNumber}`, // MsgSeqNum
        `52=${getUTCTimestamp()}`, // SendingTime
        `262=MDR_${Date.now()}`, // MDReqID (unique identifier)
        "263=1", // SubscriptionRequestType (1 = Snapshot + Updates)
        "264=0", // MarketDepth (0 = Full Book)
        "267=2", // NoMDEntryTypes (2 types: BID and ASK)
        "269=0", // First MDEntryType - BID
        "269=1", // Second MDEntryType - ASK
        "146=1", // NoRelatedSym (1 symbol)
        `55=${pair.currpair}`, // Symbol
      ].join("\u0001");

      const bodyLength = messageBody.length;
      let fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`;

      const checksum = calculateChecksum(fullMessage + "\u0001");
      fullMessage = `${fullMessage}\u000110=${checksum}\u0001`;

      this.client.write(fullMessage);

      console.log(`Sent market data subscription request for ${pair.currpair}`);
      console.log("Raw message sent:", fullMessage.replace(/\u0001/g, "|"));

      // Add a small delay between requests to prevent overwhelming the server
      if (pairsToSubscribe.indexOf(pair) < pairsToSubscribe.length - 1) {
        console.log("Waiting before sending next subscription...");
        setTimeout(() => {}, 200);
      }
    }
  }

  disconnect() {
    this.cleanupConnection();
    
    if (isConnected) {
      const logoutMessage = createFixMessage({
        35: "5", // Logout
      });
      this.client.write(logoutMessage);
      console.log("Logout message sent");
    }
    this.client.end();
  }
}

// Create and connect the FIX client
const fixClient = new FixClient();
fixClient.connect();

// Handle application shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  fixClient.disconnect();

  console.log("Closing WebSocket server...");
  wss.close();

  console.log("Closing database connection...");
  pgPool.end().then(() => {
    console.log("Database connection closed");
    process.exit(0);
  });
});