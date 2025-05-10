import type { Socket } from "net"
import type { TLSSocket } from "tls"

export interface ParsedFixMessage {
  messageType: string
  senderCompId: string
  targetCompId: string
  msgSeqNum: number
  sendingTime: string
  rawMessage: string
  testReqId?: string
  username?: string
  additionalFields: Record<string, string>
}

export class Fix {
  public client: Socket | TLSSocket | null
  protected reconnectAttempts: number
  protected readonly maxReconnectAttempts: number
  protected readonly reconnectDelay: number
  protected buffer: string
  protected heartbeatInterval: NodeJS.Timeout | null
  protected resubscribeInterval: NodeJS.Timeout | null
  public sequenceNumber: number
  public isConnected: boolean
  protected reconnectTimeout: NodeJS.Timeout | null
  public readonly senderCompId: string
  public readonly targetCompId: string
  public readonly username: string
  public readonly password: string
  protected logger: any
  protected MESSAGE_TYPES: Record<string, string>

  // Change onMessage to be a property that can be assigned a function
  public onMessage?: (parsed: ParsedFixMessage, rawMessage: string) => void
  public onResubscribe?: () => void

  constructor(senderCompId: string, targetCompId: string, username: string, password: string, logger: any) {
    this.client = null
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 1000
    this.reconnectDelay = 5000
    this.buffer = ""
    this.heartbeatInterval = null
    this.resubscribeInterval = null
    this.sequenceNumber = 0
    this.isConnected = false
    this.reconnectTimeout = null
    this.senderCompId = senderCompId
    this.targetCompId = targetCompId
    this.username = username
    this.password = password
    this.logger = logger
    this.MESSAGE_TYPES = {
      "0": "Heartbeat",
      "1": "Test Request",
      "2": "Resend Request",
      "3": "Reject",
      "4": "Sequence Reset",
      "5": "Logout",
      A: "Logon",
      D: "New Single Order",
      "8": "Execution Report",
      j: "Business Reject",
      F: "Order Cancel",
      H: "Order Status",
      "9": "Order Cancel Reject",
      V: "Market Data Request",
      W: "Market Data Snapshot",
      X: "Market Data Incremental Refresh",
    }
  }

  protected initializeClient() {
    // This method will be overridden by child classes
  }

  protected setupEventHandlers() {
    if (this.client) {
      this.client.on("connect", this.handleConnect.bind(this))
      this.client.on("data", this.handleData.bind(this))
      this.client.on("error", this.handleError.bind(this))
      this.client.on("close", this.handleClose.bind(this))
      this.client.on("end", this.handleEnd.bind(this))
    }
  }

  public getUTCTimestamp(): string {
    const now = new Date()
    return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
      2,
      "0",
    )}${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(
      2,
      "0",
    )}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(
      2,
      "0",
    )}.${String(now.getUTCMilliseconds()).padStart(3, "0")}`
  }

  public calculateChecksum(message: string): string {
    let sum = 0
    for (let i = 0; i < message.length; i++) {
      sum += message.charCodeAt(i)
    }
    return (sum % 256).toString().padStart(3, "0")
  }

  public createFixMessage(body: Record<string | number, string | number>): string {
    this.sequenceNumber += 1

    const messageBody = [
      `35=${body[35]}`,
      `49=${this.senderCompId}`,
      `56=${this.targetCompId}`,
      `34=${this.sequenceNumber}`,
      `52=${this.getUTCTimestamp()}`,
      ...Object.entries(body)
        .filter(([key]) => !["35"].includes(key))
        .map(([key, value]) => `${key}=${value}`),
    ].join("\u0001")

    const bodyLength = messageBody.length
    const fullMessage = `8=FIX.4.4\u00019=${bodyLength}\u0001${messageBody}`
    const checksum = this.calculateChecksum(fullMessage + "\u0001")
    return `${fullMessage}\u000110=${checksum}\u0001`
  }

  public parseFixMessage(message: string): ParsedFixMessage {
    const fields = message.split("\u0001")
    const fieldMap: Record<string, string> = {}

    fields.forEach((field) => {
      const [key, value] = field.split("=")
      if (key && value) {
        fieldMap[key] = value
      }
    })

    const messageType = fieldMap["35"]
    const readableType =
      this.MESSAGE_TYPES[messageType as keyof typeof this.MESSAGE_TYPES] || `Unknown (${messageType})`

    const parsed: ParsedFixMessage = {
      messageType: readableType,
      senderCompId: fieldMap["49"] || "",
      targetCompId: fieldMap["56"] || "",
      msgSeqNum: Number.parseInt(fieldMap["34"] || "0"),
      sendingTime: fieldMap["52"] || "",
      rawMessage: message,
      additionalFields: {},
    }

    if (fieldMap["112"]) parsed.testReqId = fieldMap["112"]
    if (fieldMap["553"]) parsed.username = fieldMap["553"]

    Object.entries(fieldMap).forEach(([key, value]) => {
      if (!["8", "9", "35", "49", "56", "34", "52", "10", "112", "553"].includes(key)) {
        parsed.additionalFields[key] = value as string
      }
    })

    return parsed
  }

  public logParsedMessage(parsed: ParsedFixMessage, direction: string): void {
    const timestamp = new Date().toISOString()

    // console.log("\n" + "=".repeat(80))
    // console.log(`${direction} at ${timestamp}`)
    // console.log("-".repeat(80))
    // console.log(`Message Type: ${parsed.messageType}`)
    // console.log(`From: ${parsed.senderCompId}`)
    // console.log(`To: ${parsed.targetCompId}`)
    // console.log(`Sequence: ${parsed.msgSeqNum}`)
    // console.log(`Time: ${parsed.sendingTime}`)

    const logMessage = JSON.stringify({
      direction,
      timestamp,
      messageType: parsed.messageType,
      senderCompId: parsed.senderCompId,
      targetCompId: parsed.targetCompId,
      msgSeqNum: parsed.msgSeqNum,
      sendingTime: parsed.sendingTime,
    })

    this.logger.info(logMessage)

    if (parsed.testReqId) {
      // console.log(`Test Request ID: ${parsed.testReqId}`)
      this.logger.info(`Test Request ID: ${parsed.testReqId}`)
    }

    if (Object.keys(parsed.additionalFields).length > 0) {
      // console.log("\nAdditional Fields:")
      this.logger.info("Additional Fields:")

      Object.entries(parsed.additionalFields).forEach(([key, value]) => {
        // console.log(`  ${key}: ${value}`)
        this.logger.info(`  ${key}: ${value}`)
      })
    }

    // console.log("=".repeat(80) + "\n")
  }

  protected handleConnect() {
    this.logger.info("Connected to Fix Server")
    // console.log("Connected to FIX server")
    this.resetSequenceNumbers()
    this.sendLogon()
  }

  protected sendLogon() {
    this.isConnected = true
    this.reconnectAttempts = 0
    this.buffer = ""

    const logonMessage = this.createFixMessage({
      35: "A",
      98: 0,
      108: 30,
      553: this.username,
      554: this.password,
      141: "Y",
    })

    if (this.client) {
      this.client.write(logonMessage)
    }
    const parsed = this.parseFixMessage(logonMessage)
    this.logger.info("Logon Sent")
    // console.log("Logon sent")
    this.logParsedMessage(parsed, "Sent")
    this.setupPeriodicTasks()
  }

  protected setupPeriodicTasks() {
    // This method will be overridden by child classes if needed
  }

  protected resetSequenceNumbers() {
    this.sequenceNumber = 0
  }

  protected handleTestRequest(testReqId: string) {
    this.logger.info(`Responding to Test Request with ID: ${testReqId}`)
    const heartbeatMessage = this.createFixMessage({
      35: "0", // Heartbeat
      112: testReqId, // Echo back the test request ID
    })

    if (this.client) {
      this.client.write(heartbeatMessage)
      this.logger.info("Sent heartbeat in response to test request")
    }
  }

  protected extractMessages(): string[] {
    const messages = []
    const delimiter = "\u000110="
    let position = 0

    while (true) {
      const start = this.buffer.indexOf("8=FIX", position)
      if (start === -1) break

      const end = this.buffer.indexOf(delimiter, start)
      if (end === -1) break

      const checksumEnd = end + delimiter.length + 3
      if (checksumEnd > this.buffer.length) break

      const message = this.buffer.substring(start, checksumEnd + 1)
      messages.push(message)

      position = checksumEnd + 1
    }

    if (position > 0) {
      this.buffer = this.buffer.substring(position)
    }

    return messages
  }

  protected handleData(data: Buffer) {
    this.buffer += data.toString()
    const messages = this.extractMessages()

    for (const message of messages) {
      const parsed = this.parseFixMessage(message)
      this.logParsedMessage(parsed, "Received")

      if (parsed.messageType === "Test Request" && parsed.testReqId) {
        this.handleTestRequest(parsed.testReqId)
      }

      if (parsed.messageType === "Sequence Reset") {
        const newSeqNo = Number.parseInt(parsed.additionalFields["36"] || "0")
        if (newSeqNo > 0) {
          this.logger.info(`Sequence reset to ${newSeqNo}`)
          // console.log(`Sequence reset to ${newSeqNo}`)
          this.sequenceNumber = newSeqNo
        }
        continue
      }

      if (this.onMessage) {
        this.onMessage(parsed, message)
      }
    }
  }

  protected handleError(err: Error) {
    this.logger.error("Socket Error", err.message)
    // console.log("Socket error:", err.message)
    if (this.isConnected) {
      this.isConnected = false
    }

    this.reconnect()
  }

  protected handleClose(hadError: boolean) {
    this.logger.info("Connection closed", hadError ? "due to error" : "normally")
    // console.log("Connection closed", hadError ? "due to error" : "normally")
    this.isConnected = false
    this.cleanupConnection()
    this.reconnect()
  }

  protected handleEnd() {
    this.logger.info("Connection ended")
    // console.log("Connection ended")
    this.isConnected = false
    this.cleanupConnection()
    this.reconnect()
  }

  protected cleanupConnection() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.resubscribeInterval) {
      clearInterval(this.resubscribeInterval)
      this.resubscribeInterval = null
    }
  }

  protected reconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      this.logger.info(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`,
      )
      //   console.log(
      //   `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`,
      // )

      this.reconnectTimeout = setTimeout(() => {
        this.cleanupConnection()
        this.initializeClient()
        this.connect()
      }, this.reconnectDelay)
    } else {
      this.logger.info(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
      // console.log(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
    }
  }

  public connect(host?: string, port?: number) {
    // This method will be overridden by child classes
  }

  public disconnect() {
    this.cleanupConnection()

    if (this.isConnected) {
      const logoutMessage = this.createFixMessage({
        35: "5",
      })
      if (this.client) {
        this.client.write(logoutMessage)
      }
      this.logger.info("Logout message sent")
      // console.log("Logout message sent")
    }
    if (this.client) {
      this.client.end()
    }
  }
}

