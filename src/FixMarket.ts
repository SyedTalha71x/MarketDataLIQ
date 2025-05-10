import { Socket } from "net"
import { Fix } from "./Fix"
import marketLogger from "./logger"

class FixMarket extends Fix {
  constructor(senderCompId: string, targetCompId: string, username: string, password: string) {
    super(senderCompId, targetCompId, username, password, marketLogger)
    this.initializeClient()
  }

  protected initializeClient() {
    this.client = new Socket()
    this.client.setKeepAlive(true, 30000)
    this.client.setNoDelay(true)
    this.setupEventHandlers()
  }

  protected setupPeriodicTasks() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    if (this.resubscribeInterval) clearInterval(this.resubscribeInterval)
    this.resubscribeInterval = setInterval(() => {
      if (this.isConnected) {
        marketLogger.info("Periodic resubscription to market data")
        if (this.onResubscribe) {
          this.onResubscribe()
        }
      }
    }, 300000)
  }

  public connect(host: string, port: number) {
    try {
      marketLogger.info(`Connecting to FIX server at ${host}:${port}...`)
      // console.log(`Connecting to FIX server at ${host}:${port}...`)
      if (this.client) {
        ; (this.client as Socket).connect(port, host)
      }
    } catch (error) {
      marketLogger.error("Error connecting to FIX server:", error)
      console.error("Error connecting to FIX server:", error)
      this.reconnect()
    }
  }

  protected reconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      marketLogger.info(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`,
      )
      //   console.log(
      //   `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`,
      // )

      this.reconnectTimeout = setTimeout(() => {
        this.cleanupConnection()
        this.initializeClient()
        const host = process.env.FIX_SERVER_WITHOUT_SSL_MD || ""
        const port = process.env.FIX_PORT_WITHOUT_SSL_MD
          ? Number.parseInt(process.env.FIX_PORT_WITHOUT_SSL_MD, 10)
          : 12010
        this.connect(host, port)
      }, this.reconnectDelay)
    } else {
      marketLogger.info(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
      // console.log(`Maximum reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`)
    }
  }
}

export { FixMarket }
