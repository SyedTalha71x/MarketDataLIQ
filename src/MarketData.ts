import { pgPool, MarketDataMessage, ensureTableExists, availableCurrencyPairs, marketDataQueue } from './FixClient.js';

console.log('Starting market data queue worker...');

const getContractSize = async (symbol: string): Promise<number> => {
    // Find the currency pair in our available list
    const pairInfo = availableCurrencyPairs.find(pair => pair.currpair === symbol);
    
    if (pairInfo && pairInfo.contractsize !== null) {
        return parseFloat(pairInfo.contractsize.toString());
    } else {
        console.log(`Contract size not found for ${symbol}, using default 100000`);
        return 100000; // Default contract size for testing
    }
};

// Calculate lots based on quantity and contract size
const calculateLots = (quantity: number, contractSize: number): number => {
    console.log(`Calculating lots: ${quantity} / ${contractSize} = ${Math.round(quantity / contractSize)}`);
    return Math.round(quantity / contractSize);
};

// Process and save market data to database
const saveToDatabase = async (data: MarketDataMessage) => {
    try {
        console.log(`Processing data for ${data.symbol} (${data.type})`);
        
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
        return true;
    } catch (error) {
        console.error(`Error saving data to database:`, error);
        throw error;
    }
};

// Process queue items
marketDataQueue.process(async (job) => {
    console.log(`Processing job ${job.id} from queue`);
    const data: MarketDataMessage = job.data;
    await saveToDatabase(data);
    return { success: true };
});

// Handle completed jobs
marketDataQueue.on('completed', (job) => {
    console.log(`Job ${job.id} completed successfully`);
});

// Handle failed jobs
marketDataQueue.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed with error:`, err);
});

console.log('Market data queue worker is now processing jobs');

process.on('SIGINT', async () => {
    console.log('Shutting down worker...');
    
    await Promise.all([
        marketDataQueue.close().then(() => console.log('Queue connection closed')),
        pgPool.end().then(() => console.log('Database connection closed'))
    ]);
    
    console.log('Worker shutdown complete');
    process.exit(0);
});