export interface MarketDataMessage {
  symbol: string;
  type: "BID" | "ASK";
  price: number;
  quantity: number;
  timestamp: string;
  rawData: Record<string, string>;
}

export interface TickData {
  symbol: string;
  price: number;
  timestamp: Date;
  lots: number;
}

export interface ParsedFixMessage {
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

export interface CurrencyPairInfo {
  currpair: string;
  contractsize: number | null;
}

export interface WebSocketClient {
  currencyPairs: string[];
  fsyms: string[];
  tsyms: string[];
}
