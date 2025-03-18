// index.ts
import { fixClient } from "./src/fixClient.ts";
import { marketDataQueue, candleProcessingQueue } from "./src/queue/queue.ts";
import { pgPool } from "./src/database/db.ts";

fixClient.connect();

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  fixClient.disconnect();

  console.log("Closing Bull queue...");
  await marketDataQueue.close();
  await candleProcessingQueue.close();

  pgPool.end().then(() => {
    console.log("Database connection closed");
    process.exit(0);
  });
});