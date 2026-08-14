'use strict'

const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const { generateTopic } = require('./utils')
const ReadyResource = require('ready-resource')

class MetricHyperswarmExporter extends ReadyResource {
  constructor (options) {
    super()
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

  async _open () {
    if (this.swarm) {
      return
    }

    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (socket) => this._onConnection(socket))

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
      const discovery = this.swarm.join(this._topicBuffer, { server: false, client: true })
      await discovery.flushed()
    } catch (error) {
      console.error(`Failed to connect to metrics monitor: ${error.message}`)
    } finally {
      this.isConnecting = false
    }
  }

  /**
   * @param {Object} socket - The peer connection
   * @private
   */
  _onConnection (socket) {
    this.connection = socket

    socket.on('close', () => {
      this.isAuthenticated = false
      if (this.connection === socket) this.connection = null
    })

    socket.on('error', (err) => {
      console.error(`Hyperswarm metrics connection error: ${err.message}`)
      this.isAuthenticated = false
      if (this.connection === socket) this.connection = null
      socket.destroy()
    })

    this._authenticate()
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

  async _close () {
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
