import dotenv from "dotenv";
import { resolve } from "path";
import {configDotenv} from 'dotenv'

configDotenv()

console.log(process.env.SENDER_COMP_ID,'dddddddddddd');


const config = {
  SENDER_COMP_ID: process.env.SENDER_COMP_ID,
  TARGET_COMP_ID: process.env.TARGET_COMP_ID,
  FIX_SERVER: process.env.FIX_SERVER,
  FIX_PORT: process.env.FIX_PORT,
  USERNAME: process.env.USERNAME,
  PASSWORD: process.env.PASSWORD,
  PG_HOST: process.env.PG_HOST,
  PG_PORT: process.env.PG_PORT,
  PG_USER: process.env.PG_USER,
  PG_PASSWORD: process.env.PG_PASSWORD,
  PG_DATABASE: process.env.PG_DATABASE,
  MODE: process.env.MODE,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT
};

export default config;