import { type TLSSocket, connect as tlsConnect } from "tls"
import { configDotenv } from "dotenv"
import { readFileSync } from "fs"
import { join } from "path"
import { orderLogger } from "./logger"
import { Fix, type ParsedFixMessage } from "./Fix"

configDotenv()

const FIX_SERVER = process.env.FIX_SERVER
const FIX_PORT = process.env.FIX_PORT
const SENDER_COMP_ID = process.env.SENDER_COMP_ID
const TARGET_COMP_ID = process.env.TARGET_COMP_ID
const USERNAMET = process.env.USERNAMET
const PASSWORD = process.env.PASSWORD
const CERT_DIR = process.env.CERTIFICATE || ""

const CERT_PATH = join(CERT_DIR, "cert.pem")
const CHAIN_PATH = join(CERT_DIR, "chain.pem")
const FULLCHAIN_PATH = join(CERT_DIR, "fullchain.pem")

const CONNECTION_TIMEOUT = 60000 // 60 seconds
const HEARTBEAT_INTERVAL = 10000 // 10 seconds

interface ConnectionStats {
  connectAttempts: number
  lastConnectTime: Date | null
  lastDisconnectTime: Date | null
  totalMessagesReceived: number
  totalMessagesSent: number
}

// Helper function to maintain compatibility with the old code
export function createFixMessage(body: Record<number | string, string | number>): { message: string; seqNum: number } {
  const fixOrder = new FixOrder()
  const message = fixOrder.createFixMessage(body)
  return { message, seqNum: fixOrder.sequenceNumber }
}

export class FixOrder extends Fix {
  private logonSent = false
  private connectionStats: ConnectionStats = {
    connectAttempts: 0,
    lastConnectTime: null,
    lastDisconnectTime: null,
    totalMessagesReceived: 0,
    totalMessagesSent: 0,
  }

  constructor() {
    if (!FIX_SERVER || !FIX_PORT || !SENDER_COMP_ID || !TARGET_COMP_ID || !USERNAMET || !PASSWORD) {
      throw new Error("One or more required environment variables are missing.")
    }

    super(SENDER_COMP_ID, TARGET_COMP_ID, USERNAMET, PASSWORD, orderLogger)
    this.initializeClient()
  }

  protected initializeClient() {
    try {
      const options = {
        cert: readFileSync(CERT_PATH),
        ca: readFileSync(CHAIN_PATH),
        extraCaCerts: [readFileSync(FULLCHAIN_PATH)],
        rejectUnauthorized: false,
        enableTrace: false,
        host: FIX_SERVER,
        port: Number(FIX_PORT),
        timeout: CONNECTION_TIMEOUT,
      }

      this.client = tlsConnect(options)

      if (this.client) {
        ; (this.client as TLSSocket).setKeepAlive(true, 30000)
          ; (this.client as TLSSocket).setNoDelay(true)
          ; (this.client as TLSSocket).setTimeout(CONNECTION_TIMEOUT)
        this.setupEventHandlers()
      }
    } catch (error) {
      console.error("Error during client initialization:", error)
      throw error
    }
  }

  protected setupEventHandlers() {
    super.setupEventHandlers()
    if (this.client) {
      this.client.on("timeout", this.handleTimeout.bind(this))
    }
  }

  protected handleConnect() {
    orderLogger.info("TCP Connection established")
    // console.log("TCP Connection established")
    this.connectionStats.lastConnectTime = new Date()
    this.connectionStats.connectAttempts++
    this.isConnected = true
    this.reconnectAttempts = 0
    this.logonSent = false

    if (!this.username || !this.password) {
      throw new Error("Username or Password is not defined.")
    }

    const logonMessage = this.createFixMessage({
      35: "A",
      98: 0,
      108: 30,
      141: "Y",
      553: this.username,
      554: this.password,
    })

    orderLogger.info("Sending Logon message...")
    // console.log("Sending Logon message...")
    this.sendMessage(logonMessage)
    this.logonSent = true
    orderLogger.info("Logon has been send successfully")
    // console.log("Logon has been send successfully")
  }

  protected handleData(data: Buffer) {
    try {
      orderLogger.info("Raw data received:", data.toString())
      // console.log("Raw data received:", data.toString())
      this.buffer += data.toString()

      let startIdx = this.buffer.indexOf("8=FIX")
      while (startIdx >= 0) {
        const checksumIdx = this.buffer.indexOf("10=", startIdx)
        if (checksumIdx < 0) break

        const endIdx = this.buffer.indexOf("\u0001", checksumIdx + 3)
        if (endIdx < 0) break

        const message = this.buffer.substring(startIdx, endIdx + 1)

        if (message.startsWith("8=FIX")) {
          const parsed = this.parseFixMessage(message)
          this.logParsedMessage(parsed, "Received")
          this.handleFixMessage(parsed, message)
          this.connectionStats.totalMessagesReceived++
        }

        this.buffer = this.buffer.substring(endIdx + 1)
        startIdx = this.buffer.indexOf("8=FIX")
      }
    } catch (error) {
      orderLogger.error("Error processing received data:", error)
      orderLogger.error("Raw data that caused error:", data.toString())
      orderLogger.error("Current buffer:", this.buffer)

      console.error("Error processing received data:", error)
      console.error("Raw data that caused error:", data.toString())
      console.error("Current buffer:", this.buffer)
    }
  }

  private handleFixMessage(parsed: ParsedFixMessage, rawMessage: string) {
    if (parsed.messageType === "Reject") {
      orderLogger.error("Server rejected message:", parsed)
      console.error("Server rejected message:", parsed)
      orderLogger.error("Reject reason:", parsed.additionalFields["58"] || "Unknown")
      console.error("Reject reason:", parsed.additionalFields["58"] || "Unknown")
    }

    if (parsed.messageType === "Logon") {
      orderLogger.info("Logon acknowledged. Setting up heartbeat interval...")
      // console.log("Logon acknowledged. Setting up heartbeat interval...")
      this.heartbeatInterval = setInterval(() => {
        if (this.client && this.client.writable) {
          const heartbeat = this.createFixMessage({ 35: "0" })
          this.sendMessage(heartbeat)
          orderLogger.info("Heartbeat sent")
          // console.log("Heartbeat sent")
        } else {
          orderLogger.error("Cannot send heartbeat - socket not writable")
          console.error("Cannot send heartbeat - socket not writable")
        }
      }, HEARTBEAT_INTERVAL)
    }

    // Call the onMessage callback if it exists
    if (this.onMessage) {
      this.onMessage(parsed, rawMessage)
    }
  }

  public sendMessage(message: string) {
    if (this.client && this.client.writable) {
      this.client.write(message)
      this.connectionStats.totalMessagesSent++
      const parsed = this.parseFixMessage(message)
      this.logParsedMessage(parsed, "Sent")
    } else {
      orderLogger.error("Cannot send message - socket not writable")
      console.error("Cannot send message - socket not writable")
    }
  }

  protected handleError(err: Error) {
    orderLogger.info("Socket error:", err.message)
    // console.log("Socket error:", err.message)

    orderLogger.info("Error details:", {
      name: err.name,
      message: err.message,
      stack: err.stack,
      logonSent: this.logonSent,
    })
    // console.log("Error details:", {
    // name: err.name,
    //   message: err.message,
    //     stack: err.stack,
    //       logonSent: this.logonSent,
    // })

    super.handleError(err)
  }

  protected handleClose(hadError: boolean) {
    orderLogger.info("Connection closed", {
      hadError,
      logonSent: this.logonSent,
      isConnected: this.isConnected,
      stats: this.connectionStats,
    })
    // console.log("Connection closed", {
    // hadError,
    //   logonSent: this.logonSent,
    //     isConnected: this.isConnected,
    //       stats: this.connectionStats,
    //   })

    this.connectionStats.lastDisconnectTime = new Date()
    this.isConnected = false
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }

    if (this.client) {
      this.client.destroy()
    }
    this.reconnect()
  }

  protected handleTimeout() {
    orderLogger.info("Socket timeout - attempting reconnect")
    // console.log("Socket timeout - attempting reconnect")
    this.handleClose(false)
  }

  public connect() {
    if (!this.isConnected) {
      orderLogger.info("Initiating connection...")
      // console.log("Initiating connection...")

      orderLogger.info(`Connecting to ${FIX_SERVER}:${FIX_PORT} with SSL`)
      // console.log(`Connecting to ${FIX_SERVER}:${FIX_PORT} with SSL`)

      try {
        // The connection is already established in initializeClient for TLS
      } catch (error) {
        orderLogger.error("Error during connect:", error)
        console.error("Error during connect:", error)
      }
    }
  }

  public getConnectionStats(): ConnectionStats {
    return { ...this.connectionStats }
  }
}

process.on("uncaughtException", (err) => {
  orderLogger.error("Uncaught Exception:", err)
  console.error("Uncaught Exception:", err)
})

process.on("unhandledRejection", (reason, promise) => {
  orderLogger.error("Unhandled Rejection at:", promise, "reason:", reason)
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
})

