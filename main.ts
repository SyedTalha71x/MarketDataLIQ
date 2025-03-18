// main.ts
import { initDatabase } from "./src/database/db.ts";
import { fixClient } from "./src/fixClient.ts";

// Initialize database
initDatabase().catch((err) => {
  console.error("Failed to initialize database:", err);
});

// Connect to FIX server
fixClient.connect();