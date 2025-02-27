import { Socket } from 'net';
import pkg from 'pg';
import Queue from 'bull';
const { Pool } = pkg;
import config from "../config.ts";

// FIX connection settings
const FIX_SERVER = config.FIX_SERVER;
const FIX_PORT = config.FIX_PORT;
const SENDER_COMP_ID = config.SENDER_COMP_ID;
const TARGET_COMP_ID = config.TARGET_COMP_ID;
const USERNAME = config.USERNAME;
const PASSWORD = config.PASSWORD;

// PostgreSQL connection settings
const PG_HOST = config.PG_HOST;
const PG_PORT = config.PG_PORT;
const PG_USER = config.PG_USER;
const PG_PASSWORD = config.PG_PASSWORD;
const PG_DATABASE = config.PG_DATABASE;

const MODE = config.MODE || 'sample';

const REDIS_HOST = config.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(config.REDIS_PORT || '6379');

if (!FIX_SERVER || !FIX_PORT || !SENDER_COMP_ID || !TARGET_COMP_ID || !USERNAME || !PASSWORD) {
    console.log(FIX_SERVER,FIX_PORT,SENDER_COMP_ID,TARGET_COMP_ID,USERNAME,PASSWORD);
    
    throw new Error('One or more required environment variables are missing.');
}

let sequenceNumber = 0;
let heartbeatInterval: NodeJS.Timeout;
let isConnected = false;
let reconnectTimeout: NodeJS.Timeout | null = null;

// Create Bull Queue
const marketDataQueue = new Queue('marketData', {
    redis: {
        host: REDIS_HOST,
        port: REDIS_PORT
    }
});

// Message type for market data
interface MarketDataMessage {
    symbol: string;
    type: 'BID' | 'ASK';
    price: number;
    quantity: number;
    timestamp: string;
    rawData: Record<string, string>;
}

// FIX message types
const MESSAGE_TYPES: Record<string, string> = {
    '0': 'Heartbeat',
    '1': 'Test Request',
    '2': 'Resend Request',
    '3': 'Reject',
    '4': 'Sequence Reset',
    '5': 'Logout',
    'A': 'Logon',
    'V': 'Market Data Request',
    'W': 'Market Data Snapshot',
    'X': 'Market Data Incremental Refresh'
};

// FIX tag meanings for market data
const MD_ENTRY_TYPES: Record<string, string> = {
    '0': 'BID',
    '1': 'ASK',
    '2': 'TRADE',
    '3': 'INDEX_VALUE',
    '4': 'OPENING_PRICE',
    '5': 'CLOSING_PRICE',
    '6': 'SETTLEMENT_PRICE',
    '7': 'TRADING_SESSION_HIGH_PRICE',
    '8': 'TRADING_SESSION_LOW_PRICE'
};

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

const pgPool = new Pool({
    host: PG_HOST,
    port: PG_PORT ? Number(PG_PORT) : 5432,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE
});

interface CurrencyPairInfo {
    currpair: string;
    contractsize: number | null;
}

// Store subscribable currency pairs
let availableCurrencyPairs: CurrencyPairInfo[] = [];

// Track subscribed currency pairs
const subscribedPairs: Set<string> = new Set();

const addHardcodedCurrencyPairs = () => {
    // Adding hardcoded currency pairs with contract sizes
    availableCurrencyPairs = [
        { currpair: 'EURUSD', contractsize: 100000 },
    ];
    
    // Add to subscribed pairs
    availableCurrencyPairs.forEach(pair => {
        subscribedPairs.add(pair.currpair);
    });
    
    console.log('Added hardcoded currency pairs:', availableCurrencyPairs);
    console.log('Subscribed pairs:', Array.from(subscribedPairs));
};

const fetchCurrencyPairsFromDatabase = async () => {
    try {
        console.log('Fetching currency pairs from database...');
        const result = await pgPool.query('SELECT currpair, contractsize FROM currpairdetals');
        
        if (result.rows.length === 0) {
            console.warn('No currency pairs found in database. Falling back to hardcoded pairs.');
            addHardcodedCurrencyPairs();
            return;
        }
        
        availableCurrencyPairs = result.rows;
        
        // Add to subscribed pairs
        availableCurrencyPairs.forEach(pair => {
            subscribedPairs.add(pair.currpair);
        });
        
        console.log(`Fetched ${availableCurrencyPairs.length} currency pairs from database`);
        console.log('Subscribed pairs:', Array.from(subscribedPairs));
    } catch (error) {
        console.error('Error fetching currency pairs from database:', error);
        console.log('Falling back to hardcoded pairs');
        addHardcodedCurrencyPairs();
    }
};


const initDatabase = async () => {
    try {
        if (MODE === 'sample') {
            console.log('Running in SAMPLE mode with hardcoded data');
            addHardcodedCurrencyPairs();
        } else {
            console.log('Running in PRODUCTION mode with database data');
            await fetchCurrencyPairsFromDatabase();
        }
        
        // Create tables for all pairs
        for (const pair of availableCurrencyPairs) {
            await ensureTableExists(`ticks_${pair.currpair.toLowerCase()}_bid`, 'BID');
            await ensureTableExists(`ticks_${pair.currpair.toLowerCase()}_ask`, 'ASK');
        }
        
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing database tables:', error);
    }
};

const getUTCTimestamp = (): string => {
    const now = new Date();
    return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}.${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
};

const calculateChecksum = (message: string): string => {
    let sum = 0;
    for (let i = 0; i < message.length; i++) {
        sum += message.charCodeAt(i);
    }
    return (sum % 256).toString().padStart(3, '0');
};

const createFixMessage = (body: Record<number, string | number>): string => {
    sequenceNumber += 1;
    
    const messageBody = [
        `35=${body[35]}`,
        `49=${SENDER_COMP_ID}`,
        `56=${TARGET_COMP_ID}`,
        `34=${sequenceNumber}`,
        `52=${getUTCTimestamp()}`,
        ...Object.entries(body)
            .filter(([key]) => !['35'].includes(key))
            .map(([key, value]) => `${key}=${value}`)
    ].join('\u0001');

    const bodyLength = messageBody.length + 1;
    let fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`;
    const checksum = calculateChecksum(fullMessage + '\u0001');
    return `${fullMessage}\u000110=${checksum}\u0001`;
};

const ensureTableExists = async (tableName: string, type: 'BID' | 'ASK'): Promise<void> => {
    try {
        // Modified to use more specific check for table existence
        const tableCheck = await pgPool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = $1
            )
        `, [tableName]);
        
        if (!tableCheck.rows[0].exists) {
            console.log(`Table ${tableName} does not exist, creating it...`);
            
            await pgPool.query(`
                CREATE TABLE ${tableName} (
                    lots INTEGER PRIMARY KEY,
                    effdate TIMESTAMP WITH TIME ZONE NOT NULL,
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

class FixClient {
    private client!: Socket;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 1000;
    private readonly reconnectDelay: number = 5000;

    constructor() {
        this.initializeClient();
        // Initialize database
        initDatabase().catch(err => {
            console.error('Failed to initialize database:', err);
        });
    }

    private initializeClient() {
        this.client = new Socket();
        this.client.setKeepAlive(true, 30000);
        this.client.setNoDelay(true);
        this.setupEventHandlers();
    }

    private setupEventHandlers() {
        this.client.on('connect', this.handleConnect.bind(this));
        this.client.on('data', this.handleData.bind(this));
        this.client.on('error', this.handleError.bind(this));
        this.client.on('close', this.handleClose.bind(this));
        this.client.on('end', this.handleEnd.bind(this));
    }

    private parseFixMessage(message: string): ParsedFixMessage {
        const fields = message.split('\u0001');
        const fieldMap: Record<string, string> = {};
        
        // Parse all fields into key-value pairs
        fields.forEach(field => {
            const [key, value] = field.split('=');
            if (key && value) {
                fieldMap[key] = value;
            }
        });

        // Extract common fields
        const messageType = fieldMap['35'];
        const readableType = MESSAGE_TYPES[messageType] || `Unknown (${messageType})`;

        const parsed: ParsedFixMessage = {
            messageType: readableType,
            senderCompId: fieldMap['49'] || '',
            targetCompId: fieldMap['56'] || '',
            msgSeqNum: parseInt(fieldMap['34'] || '0'),
            sendingTime: fieldMap['52'] || '',
            rawMessage: message,
            additionalFields: {}
        };

        // Add optional fields if present
        if (fieldMap['112']) parsed.testReqId = fieldMap['112'];
        if (fieldMap['553']) parsed.username = fieldMap['553'];

        // Add any other fields to additionalFields
        Object.entries(fieldMap).forEach(([key, value]) => {
            if (!['8', '9', '35', '49', '56', '34', '52', '10', '112', '553'].includes(key)) {
                parsed.additionalFields[key] = value;
            }
        });        

        return parsed;
    }

    private logParsedMessage(parsed: ParsedFixMessage, direction: 'Sent' | 'Received') {
        const timestamp = new Date().toISOString();
        console.log('\n' + '='.repeat(80));
        console.log(`${direction} at ${timestamp}`);
        console.log('-'.repeat(80));
        console.log(`Message Type: ${parsed.messageType}`);
        console.log(`From: ${parsed.senderCompId}`);
        console.log(`To: ${parsed.targetCompId}`);
        console.log(`Sequence: ${parsed.msgSeqNum}`);
        console.log(`Time: ${parsed.sendingTime}`);

        if (parsed.testReqId) {
            console.log(`Test Request ID: ${parsed.testReqId}`);
        }

        if (Object.keys(parsed.additionalFields).length > 0) {
            console.log('\nAdditional Fields:');
            Object.entries(parsed.additionalFields).forEach(([key, value]) => {
                console.log(`  ${key}: ${value}`);
            });
        }
        console.log('='.repeat(80) + '\n');
    }

    // Add hardcoded sample data to queue
    public addHardcodedSampleDataToQueue() {
        console.log('Adding hardcoded sample data to queue...');
        
        const eurUsdBid = {
            symbol: 'EURUSD',
            type: 'BID' as 'BID' | 'ASK',
            price: 1.0473,
            quantity: 1000000,
            timestamp: new Date().toISOString(),
            rawData: {
                '55': 'EURUSD',
                '262': `MDR_${Date.now()}`,
                '268': '1',
                '269': '0', // BID
                '270': '1.0473',
                '271': '1000000',
                '273': new Date().toTimeString().split(' ')[0]
            }
        };

        const eurUsdAsk = {
            symbol: 'EURUSD',
            type: 'ASK' as 'BID' | 'ASK',
            price: 1.0478,
            quantity: 1100000,
            timestamp: new Date().toISOString(),
            rawData: {
                '55': 'EURUSD',
                '262': `MDR_${Date.now()}`,
                '268': '1',
                '269': '1', // ASK
                '270': '1.0478',
                '271': '1100000',
                '273': new Date().toTimeString().split(' ')[0]
            }
        };

        marketDataQueue.add(eurUsdBid);
        marketDataQueue.add(eurUsdAsk);

        console.log(`Added 2 hardcoded sample data messages to Bull queue`);
    }

    private handleConnect() {
        console.log('Connected to FIX server');
        isConnected = true;
        this.reconnectAttempts = 0;

        const logonMessage = createFixMessage({
            35: 'A',
            98: 0,
            108: 30,
            553: USERNAME || '',
            554: PASSWORD || '',
            141: 'Y'
        });
        
        this.client.write(logonMessage);
        const parsed = this.parseFixMessage(logonMessage);
        console.log('Logon sent');
        this.logParsedMessage(parsed, 'Sent');

        // Setup heartbeat
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (this.client.writable) {
                const heartbeat = createFixMessage({ 35: '0' });
                this.client.write(heartbeat);
                console.log('Heartbeat sent');
            }
        }, 25000);
    }

    private handleData(data: Buffer) {
        const message = data.toString();
        
        const parsed = this.parseFixMessage(message);
        this.logParsedMessage(parsed, 'Received');

        // Handle specific message types
        if (parsed.messageType === 'Test Request' && parsed.testReqId) {
            const heartbeat = createFixMessage({
                35: '0',
                112: parsed.testReqId
            });
            this.client.write(heartbeat);
            const parsedResponse = this.parseFixMessage(heartbeat);
            this.logParsedMessage(parsedResponse, 'Sent');
        } else if (parsed.messageType === 'Market Data Snapshot' || parsed.messageType === 'Market Data Incremental Refresh') {
            console.log('Received market data response!');
            // We're not processing real market data in this sample mode
        } else if (parsed.messageType === 'Reject') {
            console.log('Request rejected by server:', parsed.additionalFields['58'] || 'Unknown reason');
        }
    }

    private handleError(err: Error) {
        console.log('Socket error:', err.message);
        // Since we're focusing on sample data, go directly to sample mode on any error
        this.runSampleDataMode();
    }

    private handleClose(hadError: boolean) {
        console.log('Connection closed', hadError ? 'due to error' : 'normally');
        isConnected = false;
        
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        // Go to sample mode instead of reconnecting
        this.runSampleDataMode();
    }

    private handleEnd() {
        console.log('Connection ended');
        // Go to sample mode instead of reconnecting
        this.runSampleDataMode();
    }

    private reconnect() {
        if (reconnectTimeout !== null) {
            clearTimeout(reconnectTimeout);
        }

        // Directly run sample data mode instead of reconnecting
        this.runSampleDataMode();
    }

    public connect() {
        console.log('Skipping real connection and running in sample data mode directly');
        this.runSampleDataMode();
    }

    // Run in sample data mode without actual FIX connection
    public runSampleDataMode() {
        console.log('Running in sample data mode without FIX connection');
        
        // Add hardcoded sample data to the queue
        setTimeout(() => {
            this.addHardcodedSampleDataToQueue();
        }, 2000);
    }

    public disconnect() {
        if (isConnected) {
            const logoutMessage = createFixMessage({
                35: '5' // Logout
            });
            this.client.write(logoutMessage);
            console.log('Logout message sent');
        }
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        this.client.end();
    }
}

export {
    pgPool,
    ensureTableExists,
    availableCurrencyPairs,
    marketDataQueue
};

export type {MarketDataMessage}

// Only start the FIX client if this file is run directly (not imported)
if (require.main === module) {
    const fixClient = new FixClient();
    
    // Skip real connection and go directly to sample data mode
    fixClient.connect();
    
    process.on('SIGINT', () => {
        console.log('Shutting down FIX client...');
        fixClient.disconnect();
        
        // Close connections
        Promise.all([
            pgPool.end().then(() => console.log('Database connection closed')),
            marketDataQueue.close().then(() => console.log('Queue connection closed'))
        ]).then(() => {
            process.exit(0);
        });
    });
}