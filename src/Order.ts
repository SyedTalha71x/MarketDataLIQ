import { FixOrder, createFixMessage } from "./FixOrder"
import { orderLogger } from "./logger"
import type { ParsedFixMessage } from "./Fix"

class OrderHandler {
  private fixClient: FixOrder
  private pendingRequests = new Map<string, (value: any) => void>()
  private seqNumToClOrdId = new Map<number, string>()

  constructor() {
    this.fixClient = new FixOrder()
    this.fixClient.connect()
    this.setupMessageHandlers()
  }

  private setupMessageHandlers() {
    // Set the onMessage callback
    this.fixClient.onMessage = (parsedMessage: ParsedFixMessage) => {
      // console.log(`Message Type = ${parsedMessage.messageType}`)
      let clOrdId: string | undefined

      if (parsedMessage.messageType === "Execution Report" || parsedMessage.messageType === "Order Cancel Reject") {
        clOrdId = parsedMessage.additionalFields["11"]
      } else if (parsedMessage.messageType === "Business Reject" || parsedMessage.messageType === "Reject") {
        const refSeqNum = parsedMessage.additionalFields["45"]
        if (refSeqNum) {
          clOrdId = this.seqNumToClOrdId.get(Number.parseInt(refSeqNum))
          this.seqNumToClOrdId.delete(Number.parseInt(refSeqNum))
        }
      }

      if (clOrdId && this.pendingRequests.has(clOrdId)) {
        this.pendingRequests.get(clOrdId)?.(parsedMessage)
        this.pendingRequests.delete(clOrdId)
      }
    }
  }

  public async sendOrder(orderDetails: {
    symbol: string
    buySell: string
    quantity: number
    orderType: number
    timeInForce: string
    price?: number
  }) {
    try {
      const { symbol, buySell, quantity, orderType, timeInForce, price } = orderDetails
      const clOrdId = `ORD-${Date.now()}`
      const transactTime = new Date()
        .toISOString()
        .replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).(\d{3})Z/, "$1$2$3-$4:$5:$6.$7")

      const orderRequest: { [key: string]: any } = {
        35: "D",
        11: clOrdId,
        1: String(process.env.ACCOUNT_NAME),
        55: symbol,
        54: buySell,
        38: quantity,
        40: orderType,
        59: timeInForce,
        60: transactTime,
      }

      if (orderType == 2 || orderType == 3) {
        orderRequest[44] = price
      }

      const { message: orderMessage, seqNum } = createFixMessage(orderRequest)

      return await Promise.race([
        new Promise((resolve) => {
          this.pendingRequests.set(clOrdId, resolve)
          this.seqNumToClOrdId.set(seqNum, clOrdId)
          this.fixClient.sendMessage(orderMessage)
        }),
        new Promise((_, reject) => setTimeout(() => reject("Timeout after 30 seconds"), 30000)),
      ])
    } catch (error) {
      orderLogger.error("Error in sendOrder:", error)
      throw error
    }
  }

  public async orderStatus(statusDetails: {
    orderId: string
    clOrdId: string
    symbol: string
    buySell: string
  }) {
    try {
      const { orderId, clOrdId, symbol, buySell } = statusDetails
      const { message: orderMessage, seqNum } = createFixMessage({
        35: "H",
        1: String(process.env.ACCOUNT_NAME),
        11: clOrdId,
        37: orderId,
        54: buySell,
        55: symbol,
      })

      return await Promise.race([
        new Promise((resolve) => {
          this.pendingRequests.set(clOrdId, resolve)
          this.seqNumToClOrdId.set(seqNum, clOrdId)
          this.fixClient.sendMessage(orderMessage)
        }),
        new Promise((_, reject) => setTimeout(() => reject("Timeout after 30 seconds"), 30000)),
      ])
    } catch (error) {
      orderLogger.error("Error in orderStatus:", error)
      throw error
    }
  }

  public async orderCancel(cancelDetails: {
    orderId: string
    buySell: string
  }) {
    try {
      const { orderId, buySell } = cancelDetails
      const transactTime = new Date()
        .toISOString()
        .replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).(\d{3})Z/, "$1$2$3-$4:$5:$6.$7")

      const clOrdId = `ORD-${Date.now()}`
      const { message: orderMessage, seqNum } = createFixMessage({
        35: "F",
        1: String(process.env.ACCOUNT_NAME),
        11: clOrdId,
        41: orderId,
        54: buySell,
        60: transactTime,
      })

      return await Promise.race([
        new Promise((resolve) => {
          this.pendingRequests.set(clOrdId, resolve)
          this.seqNumToClOrdId.set(seqNum, clOrdId)
          this.fixClient.sendMessage(orderMessage)
        }),
        new Promise((_, reject) => setTimeout(() => reject("Timeout after 30 seconds"), 30000)),
      ])
    } catch (error) {
      orderLogger.error("Error in orderCancel:", error)
      throw error
    }
  }
}

export default OrderHandler

