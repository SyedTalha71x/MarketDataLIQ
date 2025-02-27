import { Socket } from 'net';
import pkg from 'pg';
const { Pool } = pkg;
import Bull from 'bull';
import { configDotenv } from 'dotenv';

configDotenv();
// FIX connection settings
const FIX_SERVER = process.env.FIX_SERVER;
const FIX_PORT = process.env.FIX_PORT;
const SENDER_COMP_ID = process.env.SENDER_COMP_ID;
const TARGET_COMP_ID = process.env.TARGET_COMP_ID;
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

// PostgreSQL connection settings
const PG_HOST = process.env.PG_HOST;
const PG_PORT = process.env.PG_PORT;
const PG_USER = process.env.PG_USER;
const PG_PASSWORD = process.env.PG_PASSWORD;
const PG_DATABASE = process.env.PG_DATABASE;

// Redis settings for Bull
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');

if (!FIX_SERVER || !FIX_PORT || !SENDER_COMP_ID || !TARGET_COMP_ID || !USERNAME || !PASSWORD) {
    console.log('One or more required environment variables are missing, using sample mode.');
}

let sequenceNumber = 0;
let heartbeatInterval: NodeJS.Timeout | null = null; // Re-enabled but will handle differently
let isConnected = false;
let reconnectTimeout: NodeJS.Timeout | null = null;
let lastHeartbeatTime = 0;

// Market data message interface
interface MarketDataMessage {
    symbol: string;
    type: 'BID' | 'ASK';
    price: number;
    quantity: number;
    timestamp: string;
    rawData: Record<string, string>;
}

// Create Bull queue for market data processing
const marketDataQueue = new Bull('marketData', {
    redis: {
        host: REDIS_HOST,
        port: REDIS_PORT
    },
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000
        },
        removeOnComplete: true
    }
});

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
    rawType?: string; // Added to store the original message type code
}

// Initialize PostgreSQL connection pool
const pgPool = new Pool({
    host: PG_HOST,
    port: PG_PORT ? Number(PG_PORT) : 5432,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE
});

// Currency pair info with contract size
interface CurrencyPairInfo {
    currpair: string;
    contractsize: number | null;
}

// Store subscribable currency pairs
let availableCurrencyPairs: CurrencyPairInfo[] = [];

// Track subscribed currency pairs
const subscribedPairs: Set<string> = new Set();

const initDatabase = async () => {
    try {
        // Fetch from database instead of using hardcoded pairs
        await fetchAllCurrencyPairs();
        
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing database tables:', error);
    }
};

const fetchAllCurrencyPairs = async () => {
    try {
        const result = await pgPool.query('SELECT currpair, contractsize FROM currpairdetails');
        availableCurrencyPairs = result.rows;
        
        console.log(`Fetched ${availableCurrencyPairs.length} currency pairs from database`);
        
        // Filter out pairs with null contract size
        const validPairs = availableCurrencyPairs.filter(pair => pair.contractsize !== null);
        const invalidPairs = availableCurrencyPairs.filter(pair => pair.contractsize === null);
        
        console.log(`${validPairs.length} pairs have valid contract size`);
        console.log(`${invalidPairs.length} pairs have null contract size and will not be subscribed`);
        
        if (invalidPairs.length > 0) {
            console.log('Skipping subscription for the following pairs due to null contract size:');
            invalidPairs.forEach(pair => console.log(`- ${pair.currpair}`));
        }
        
        // IMPORTANT: We're not automatically subscribing here anymore
        // We'll subscribe in the subscribeToMarketData method
        
        // Prepare tables for valid pairs
        for (const pair of validPairs) {
            await ensureTableExists(`ticks_${pair.currpair.toLowerCase()}_bid`, 'BID');
            await ensureTableExists(`ticks_${pair.currpair.toLowerCase()}_ask`, 'ASK');
        }
    } catch (error) {
        console.error('Error fetching currency pairs:', error);
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

// Set up Bull queue processor
marketDataQueue.process(async (job) => {
    try {
        const data: MarketDataMessage = job.data;
        console.log(`Processing market data job for ${data.symbol} (${data.type})`);
        
        const contractSize = await getContractSize(data.symbol);
        console.log(`Got contract size: ${contractSize} for ${data.symbol}`);
        
        const lots = calculateLots(data.quantity, contractSize);
        console.log(`Calculated lots: ${lots} (${data.quantity} / ${contractSize})`);
        
        // Format time from data.timestamp
        let effdate = new Date();
        if (data.rawData['273']) {
            const timeStr = data.rawData['273'];
            const [hours, minutes, seconds] = timeStr.split(':').map(Number);
            effdate = new Date();
            effdate.setHours(hours, minutes, seconds);
        }
        
        // Determine which table to use based on the type
        let tableName: string;
        const symbolLower = data.symbol.toLowerCase();
        
        if (data.type === 'BID') {
            tableName = `ticks_${symbolLower}_bid`;
        } else {
            tableName = `ticks_${symbolLower}_ask`;
        }
        
        // Ensure the table exists before inserting data
        await ensureTableExists(tableName, data.type);
        
        const query = {
            text: `
                INSERT INTO ${tableName} 
                (lots, effdate, price)
                VALUES ($1, $2, $3)
                ON CONFLICT (lots) 
                DO UPDATE SET 
                    effdate = EXCLUDED.effdate,
                    price = EXCLUDED.price
            `,
            values: [
                lots,
                effdate.toISOString(),
                data.price
            ]
        };
        
        console.log(`Executing query for ${tableName}:`, query.text);
        console.log(`Query values:`, query.values);
        
        await pgPool.query(query);
        console.log(`✓ Successfully saved ${data.type} data for ${data.symbol} to database in ${tableName}`);
        
        return { success: true, symbol: data.symbol, type: data.type };
    } catch (error) {
        console.error(`Error processing market data job:`, error);
        throw error; // Rethrowing to trigger Bull's retry mechanism
    }
});

// Monitor queue events
marketDataQueue.on('completed', (job, result) => {
    console.log(`✅ Job ${job.id} completed: ${result.symbol} ${result.type}`);
});

marketDataQueue.on('failed', (job, error) => {
    console.error(`❌ Job ${job.id} failed:`, error);
});

// Get contract size for a symbol
const getContractSize = async (symbol: string): Promise<number> => {
    try {
        // Find the currency pair in our database-loaded list
        const pairInfo = availableCurrencyPairs.find(pair => pair.currpair === symbol);
        
        if (pairInfo && pairInfo.contractsize !== null) {
            return parseFloat(pairInfo.contractsize.toString());
        } else {
            console.log(`Contract size not found for ${symbol}, using default 100000`);
            return 100000; // Default contract size if not found
        }
    } catch (error) {
        console.error(`Error getting contract size for ${symbol}:`, error);
        return 100000; // Default in case of error
    }
};

// Calculate lots based on quantity and contract size
const calculateLots = (quantity: number, contractSize: number): number => {
    console.log(`Calculating lots: ${quantity} / ${contractSize} = ${Math.round(quantity / contractSize)}`);
    return Math.round(quantity / contractSize);
};

class FixClient {
    private client!: Socket;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 1000;
    private readonly reconnectDelay: number = 5000;
    private messageBuffer: string = '';
    private subscribedCount: number = 0;
    private subscriptionQueue: CurrencyPairInfo[] = [];
    private isSubscribing: boolean = false;
    private heartbeatTimeout: NodeJS.Timeout | null = null;

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
            rawType: messageType, // Store the original type code
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

    private handleConnect() {
        console.log('Connected to FIX server');
        isConnected = true;
        this.reconnectAttempts = 0;
        this.messageBuffer = '';

        const logonMessage = createFixMessage({
            35: 'A',
            98: 0,
            108: 30, // Heartbeat interval in seconds
            553: USERNAME || '',
            554: PASSWORD || '',
            141: 'Y'
        });
        
        this.client.write(logonMessage);
        const parsed = this.parseFixMessage(logonMessage);
        console.log('Logon sent');
        this.logParsedMessage(parsed, 'Sent');

        // Set up heartbeat timeout (server should respond within 30 seconds)
        this.setupHeartbeatMonitor();
        
        // We'll start subscription only after receiving a successful logon response
        this.subscribedCount = 0;
        this.isSubscribing = false;
    }

    private setupHeartbeatMonitor() {
        // Clear any existing timeout
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }

        // Set a timeout to check for server heartbeats
        this.heartbeatTimeout = setTimeout(() => {
            const now = Date.now();
            const timeSinceLastHeartbeat = now - lastHeartbeatTime;
            
            if (timeSinceLastHeartbeat > 35000) { // 35 seconds (a bit more than heartbeat interval)
                console.log('No heartbeat received for 35 seconds, sending test request');
                // Send test request
                if (this.client.writable) {
                    const testRequest = createFixMessage({
                        35: '1', // Test request
                        112: `TEST_${Date.now()}` // TestReqID
                    });
                    this.client.write(testRequest);
                    const parsed = this.parseFixMessage(testRequest);
                    this.logParsedMessage(parsed, 'Sent');
                }
                
                // Set another timeout to check if we get a response
                setTimeout(() => {
                    if (Date.now() - lastHeartbeatTime > 40000) {
                        console.log('No response to test request, disconnecting...');
                        this.client.destroy();
                        isConnected = false;
                    }
                }, 5000);
            } else {
                // Schedule next check
                this.setupHeartbeatMonitor();
            }
        }, 35000);
    }

    private handleData(data: Buffer) {
        // Update last heartbeat time
        lastHeartbeatTime = Date.now();
        
        // Process incoming data
        this.messageBuffer += data.toString();
        
        // Handle complete FIX messages (terminated by SOH character)
        const messages = this.messageBuffer.split(/\u0001\d+=/);
        
        // Keep the last incomplete message, if any
        this.messageBuffer = messages.pop() || '';
        
        // Process complete messages
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message.trim()) continue;
            
            // Ensure the message starts with 8=FIX
            if (!message.startsWith('8=FIX')) {
                // Check if this is a continuation of the previous message
                messages[i-1] += message;
                continue;
            }
            
            const fullMessage = message + '\u00018=' + this.messageBuffer;
            const parsed = this.parseFixMessage(fullMessage);
            this.logParsedMessage(parsed, 'Received');
            
            // Handle different message types
            this.handleMessageByType(parsed);
        }
        
        // Reset buffer
        this.messageBuffer = '';
    }

    private handleMessageByType(parsed: ParsedFixMessage) {
        // Check the raw message type for more precise handling
        switch (parsed.rawType) {
            case '0': // Heartbeat
                // Update heartbeat time and keep connection alive
                console.log('Received heartbeat from server');
                break;
                
            case '1': // Test Request
                if (parsed.testReqId) {
                    console.log(`Responding to test request: ${parsed.testReqId}`);
                    const heartbeat = createFixMessage({
                        35: '0', // Heartbeat
                        112: parsed.testReqId // Echo back the TestReqID
                    });
                    this.client.write(heartbeat);
                }
                break;
                
            case 'A': // Logon Response
                console.log('Logon successful');
                // Start subscription process after successful login
                setTimeout(() => {
                    this.prepareMarketDataSubscription();
                }, 1000);
                break;
                
            case 'W': // Market Data Snapshot
            case 'X': // Market Data Incremental Refresh
                this.processMarketData(parsed);
                break;
                
            case '3': // Reject
                console.log('Request rejected by server:', parsed.additionalFields['58'] || 'Unknown reason');
                break;
                
            case '5': // Logout
                console.log('Server sent logout message');
                isConnected = false;
                this.client.end();
                break;
                
            default:
                console.log(`Received unhandled message type: ${parsed.messageType} (${parsed.rawType})`);
        }
    }

    private prepareMarketDataSubscription() {
        if (!isConnected) {
            console.log('Not connected to FIX server. Cannot subscribe to market data.');
            return;
        }

        const validPairs = availableCurrencyPairs.filter(pair => pair.contractsize !== null);
        console.log(`Preparing to subscribe to ${validPairs.length} currency pairs...`);
        
        // Queue up the currency pairs for subscription
        this.subscriptionQueue = [...validPairs];
        
        // Start the subscription process
        this.subscribeToNext();
    }

    private subscribeToNext() {
        if (this.subscriptionQueue.length === 0 || this.isSubscribing) {
            return;
        }
        
        this.isSubscribing = true;
        const pair = this.subscriptionQueue.shift();
        
        if (!pair) {
            this.isSubscribing = false;
            console.log('All currency pairs have been subscribed to.');
            return;
        }
        
        console.log(`Subscribing to market data for ${pair.currpair} (${this.subscribedCount + 1}/${availableCurrencyPairs.filter(p => p.contractsize !== null).length})`);
        
        // Create a Market Data Request message
        const marketDataRequest = createFixMessage({
            35: 'V', // Market Data Request
            262: `MDR_${Date.now()}`, // MDReqID
            263: '1', // SubscriptionRequestType (1 = Snapshot + Updates)
            264: '0', // Market Depth (0 = Full book)
            265: '1', // MDUpdateType (1 = Full refresh)
            267: '2', // NoMDEntryTypes
            '269.1': '0', // MDEntryType - BID
            '269.2': '1', // MDEntryType - ASK
            146: '1', // NoRelatedSym
            '55.1': pair.currpair // Symbol
        });
        
        this.client.write(marketDataRequest);
        const parsed = this.parseFixMessage(marketDataRequest);
        this.logParsedMessage(parsed, 'Sent');
        
        // Add to subscribed pairs set
        subscribedPairs.add(pair.currpair);
        this.subscribedCount++;
        
        console.log(`Sent subscription request for ${pair.currpair}`);
        
        // Set a timeout to subscribe to the next pair (allow some time for response)
        setTimeout(() => {
            this.isSubscribing = false;
            this.subscribeToNext();
        }, 500); // Throttle subscriptions to not overwhelm the server
    }

    private processMarketData(parsed: ParsedFixMessage) {
        try {
            // Extract market data entries
            const noMDEntries = parseInt(parsed.additionalFields['268'] || '0');
            const symbol = parsed.additionalFields['55'] || '';
            
            if (noMDEntries > 0 && symbol && subscribedPairs.has(symbol)) {
                console.log(`Processing ${noMDEntries} market data entries for ${symbol}`);
                
                // Process each entry
                for (let i = 1; i <= noMDEntries; i++) {
                    const typeTag = `269.${i}`;
                    const priceTag = `270.${i}`;
                    const sizeTag = `271.${i}`;
                    const timeTag = `273.${i}`;
                    
                    if (parsed.additionalFields[typeTag] && parsed.additionalFields[priceTag]) {
                        const entryType = parsed.additionalFields[typeTag];
                        const price = parseFloat(parsed.additionalFields[priceTag]);
                        const size = parseInt(parsed.additionalFields[sizeTag] || '0');
                        const time = parsed.additionalFields[timeTag] || '';
                        
                        if (['0', '1'].includes(entryType)) { // BID or ASK
                            const type = MD_ENTRY_TYPES[entryType];
                            
                            // Create market data message and add to queue
                            const marketData: MarketDataMessage = {
                                symbol,
                                type: type as 'BID' | 'ASK',
                                price,
                                quantity: size,
                                timestamp: new Date().toISOString(),
                                rawData: {
                                    '55': symbol,
                                    '262': parsed.additionalFields['262'] || '',
                                    '268': parsed.additionalFields['268'] || '',
                                    '269': entryType,
                                    '270': price.toString(),
                                    '271': size.toString(),
                                    '273': time
                                }
                            };
                            
                            // Add to Bull queue
                            marketDataQueue.add(marketData, { 
                                jobId: `${symbol}_${type}_${Date.now()}` 
                            });
                            
                            console.log(`Added ${type} data for ${symbol} to queue: ${price}`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error processing market data:', error);
        }
    }

    private handleError(err: Error) {
        console.log('Socket error:', err.message);
        
        // Try to reconnect on error
        if (isConnected) {
            isConnected = false;
            if (this.heartbeatTimeout) {
                clearTimeout(this.heartbeatTimeout);
                this.heartbeatTimeout = null;
            }
        }
        
        this.reconnect();
    }

    private handleClose(hadError: boolean) {
        console.log('Connection closed', hadError ? 'due to error' : 'normally');
        isConnected = false;
        
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }

        // Try to reconnect on close
        this.reconnect();
    }

    private handleEnd() {
        console.log('Connection ended');
        isConnected = false;
        
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
        
        // Try to reconnect on end
        this.reconnect();
    }

    private reconnect() {
        if (reconnectTimeout !== null) {
            clearTimeout(reconnectTimeout);
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`);
            
            reconnectTimeout = setTimeout(() => {
                this.connect();
            }, this.reconnectDelay);
        } else {
            console.log(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
        }
    }

    public connect() {
        try {
            console.log(`Connecting to FIX server at ${FIX_SERVER}:${FIX_PORT}...`);
            this.client.connect(Number(FIX_PORT), FIX_SERVER);
        } catch (error) {
            console.error('Error connecting to FIX server:', error);
            this.reconnect();
        }
    }

    public disconnect() {
        if (isConnected) {
            const logoutMessage = createFixMessage({
                35: '5' // Logout
            });
            this.client.write(logoutMessage);
            console.log('Logout message sent');
        }
        
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
        
        this.client.end();
    }
}

const fixClient = new FixClient();

// Connect to real FIX server
fixClient.connect();

// Listen for shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    fixClient.disconnect();
    
    // Close Bull queue
    console.log('Closing Bull queue...');
    await marketDataQueue.close();
    
    // Close database connection
    pgPool.end().then(() => {
        console.log('Database connection closed');
        process.exit(0);
    });
});