import winston from 'winston';
import { format } from 'winston';
import fs from 'fs';
import path from 'path';

// Ensure logs directory exists
const logDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Base configuration for all loggers
const createServiceLogger = (serviceName: string) => {
  const logFormat = format.printf(({ level, message }) => {
    return `[${level}] ${serviceName}: ${message}`;
  });

  const transports = [
    // File transport (plain text)
    new winston.transports.File({
      filename: path.join(logDir, `${serviceName}.log`),
      format: logFormat
    })
  ];

  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports,
    exitOnError: false
  });
};

const marketLogger = createServiceLogger('marketData');
const orderLogger = createServiceLogger('orderData');
const marketLoggerLot1 = createServiceLogger('marketLoggerLot1');


export default marketLogger;

export {
  orderLogger,
  marketLoggerLot1
}