// server.ts
import { configDotenv } from "dotenv";
import express, { Request, Response } from "express";
import Joi from 'joi';
import OrderHandler from "./Order";
import MarketDataHandler from "./MarketData";
import marketLogger from "./logger";

configDotenv();

const port = process.env.PRODUCTION_PORT;
const app = express();
app.use(express.json());

// Create instances when server starts
const orderHandler = new OrderHandler();
const marketDataClient = new MarketDataHandler();

if (process.env.MARKET_SOCKET === "true") {
  const marketDataClient = new MarketDataHandler();
  marketDataClient.connect();
  marketLogger.info("Market data client connected");
  console.log("Market data client connected");
}
else {
  marketLogger.info("Market data client not connected, please check env variable MARKET_SOCKET");
  console.log("Market data client not connected, please check env variable MARKET_SOCKET");
}

// Define the validation schema
const orderSchema = Joi.object({
  symbol: Joi.string().required(),
  buySell: Joi.number().valid(1, 2).required(),
  quantity: Joi.number().positive().required(),
  orderType: Joi.number().valid(1, 2, 3).required(),
  timeInForce: Joi.number().valid(1, 2, 3).required(),
  price: Joi.when('orderType', {
    is: 'limit',
    then: Joi.number().positive().required(),
    otherwise: Joi.number().optional()
  })
});

app.post("/api/send-order", async (req: Request, res: Response) => {
  try {
    // Validate the request body
    const { error, value } = orderSchema.validate(req.body, { abortEarly: false });

    if (error) {
      // Return 400 Bad Request with all validation errors
      res.status(400).json({ errors: error.details.map(d => d.message) });
    }

    // If validation passes, use the validated data
    const { symbol, buySell, quantity, orderType, timeInForce, price } = value;
    const response = await orderHandler.sendOrder({
      symbol,
      buySell,
      quantity,
      orderType,
      timeInForce,
      price
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : error });
  }
});

app.post("/api/order-status", async (req: Request, res: Response) => {
  try {
    const { orderId, clOrdId, symbol, buySell } = req.body;
    const response = await orderHandler.orderStatus({
      orderId,
      clOrdId,
      symbol,
      buySell
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : error });
  }
});

app.post("/api/order-cancel", async (req: Request, res: Response) => {
  try {
    const { orderId, buySell } = req.body;
    const response = await orderHandler.orderCancel({
      orderId,
      buySell
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : error });
  }
});

// app.post("/api/market-data", async (req: Request, res: Response) => {
//   try {    
//     const { currpair } = req.body;
//     marketDataClient.setRequestedCurrpair(currpair);
//     res.json("Ok");
//   } catch (error) {
//     res.status(500).json({ error: error instanceof Error ? error.message : error });
//   }
// });

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});