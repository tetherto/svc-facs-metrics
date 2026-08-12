'use strict'

const Hyperswarm = require('hyperswarm')
const b4a = require('b4a')
const { generateTopic } = require('./utils')

/**
 * Exports metrics to tether-wrk-monitor via Hyperswarm
 */
class MetricHyperswarmExporter {
  constructor (options) {
    this.app = options.app
    this.topic = options.topic
    this.secretKey = options.secretKey
    this.baseLabels = options.baseLabels || {}
    this.instance = options.instance || `${process.pid}`
    this.flushInterval = options.flushInterval || 15000

    this.swarm = null
    this.connection = null
    this.isAuthenticated = false
    this.isConnecting = false

    this._topicBuffer = generateTopic(this.topic)
  }

  /**
   * Start the exporter and connect to monitor
   */
  async start () {
    if (this.swarm) {
      return
    }

    this.swarm = new Hyperswarm()

    await this._connectToMonitor()
  }

  /**
   * Connect to tether-wrk-monitor via Hyperswarm
   * @private
   */
  async _connectToMonitor () {
    if (this.isConnecting) {
      return
    }

    this.isConnecting = true

    try {
      this.swarm.on('connection', (socket) => {
        this.connection = socket

        socket.on('close', () => {
          this.isAuthenticated = false
          this.connection = null
        })

        socket.on('error', (err) => {
          console.error(`Hyperswarm metrics connection error: ${err.message}`)
          this.isAuthenticated = false
          this.connection = null
        })

        this._authenticate()
      })

      const discovery = this.swarm.join(this._topicBuffer, { server: false, client: true })
      await discovery.flushed()
    } catch (error) {
      console.error(`Failed to connect to metrics monitor: ${error.message}`)
    } finally {
      this.isConnecting = false
    }
  }

  /**
   * Authenticate with the monitor
   * @private
   */
  _authenticate () {
    if (!this.connection || this.connection.destroyed) {
      return
    }

    const authMessage = {
      type: 'prom.auth',
      labels: {
        app: this.app,
        instance: this.instance,
        ...this.baseLabels
      },
      secretKey: this.secretKey
    }

    try {
      this.connection.write(b4a.from(JSON.stringify(authMessage)))
      this.isAuthenticated = true
    } catch (error) {
      console.error(`Failed to authenticate metrics: ${error.message}`)
    }
  }

  /**
   * Send metrics to monitor
   * @param {Object} metrics - Metrics to send
   */
  sendMetrics (metrics) {
    if (!this.isAuthenticated || !this.connection || this.connection.destroyed ||
      Object.keys(metrics).length === 0) {
      return
    }

    const message = {
      type: 'prom.metrics',
      metrics,
      timestamp: Date.now()
    }

    try {
      this.connection.write(b4a.from(JSON.stringify(message)))
    } catch (error) {
      console.error(`Failed to send metrics: ${error.message}`)
    }
  }

  /**
   * Stop the exporter and close connections
   */
  async stop () {
    if (this.connection) {
      this.connection.end()
      this.connection = null
    }

    if (this.swarm) {
      await this.swarm.destroy()
      this.swarm = null
    }

    this.isAuthenticated = false
  }
}

module.exports = MetricHyperswarmExporter
