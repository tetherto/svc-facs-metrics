'use strict'

const path = require('path')
const async = require('async')
const Base = require('@bitfinex/bfx-facs-base')
const MetricsRegistry = require('./lib/metrics-registry')
const BaseCollector = require('./lib/collectors/base-collector')
const MetricsHyperswarmExporter = require('./lib/metrics-hyperswarm-exporter')

class MetricsFacility extends Base {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'metrics'
    this.instance = opts.instance || `${process.pid}`
    this.app = opts.app || 'app'
    this.baseLabels = opts.baseLabels || null
    this._hasConf = true
    this.init()
  }

  init () {
    super.init()

    this.registry = new MetricsRegistry({ maxSeries: this.conf?.maxSeries })
    this.isEnabled = false
    this.collectors = new Map()
  }

  _start (cb) {
    async.series([
      next => { super._start(next) },
      async () => {
        if (!this.conf || this.conf.enabled === false) {
          return
        }

        if (!this.conf.topic || !this.conf.secretKey) {
          throw new Error('ERR_METRICS_CONFIG_MISSING_REQUIRED_FIELDS: topic and secretKey are required')
        }

        this.exporter = new MetricsHyperswarmExporter({
          app: this.app,
          instance: this.instance,
          baseLabels: { ...(this.conf.baseLabels || {}), ...(this.baseLabels || {}) },
          topic: this.conf.topic,
          secretKey: this.conf.secretKey,
          flushInterval: this.conf.flushInterval || 15000
        })

        await this.exporter.ready()
        this.isEnabled = true

        this._startConfiguredCollectors()

        const flushInterval = this.conf.flushInterval || 15000
        this.flushTimer = setInterval(
          () => this._flush(),
          flushInterval
        )
      }
    ], cb)
  }

  _stop (cb) {
    async.series([
      async () => {
        await this._stopCollectors()
        if (this.flushTimer) {
          clearInterval(this.flushTimer)
          this.flushTimer = null
        }

        this._flush()
        if (this.exporter) {
          await this.exporter.close()
        }
      },
      next => { super._stop(next) }
    ], cb)
  }

  /**
   * @private
   */
  _startConfiguredCollectors () {
    const configured = Array.isArray(this.conf.collectors) ? this.conf.collectors : []

    for (const entry of configured) {
      if (!entry || entry.enabled === false) continue

      try {
        this.addCollector(this._resolveCollector(entry.collector), {
          interval: entry.interval,
          key: entry.key || String(entry.collector),
          opts: entry.opts
        })
      } catch (err) {
        console.error(`Failed to start collector '${entry.collector}': ${err.message}`)
      }
    }
  }

  /**
   * @param {string|Function} ref - Module path/id, or a class
   * @returns {Function} Collector class
   * @private
   */
  _resolveCollector (ref) {
    if (typeof ref === 'function') return ref
    if (typeof ref !== 'string' || !ref) throw new Error('ERR_COLLECTOR_REF_INVALID')

    const target = ref.startsWith('.') ? path.resolve(process.cwd(), ref) : ref
    const resolved = require.resolve(target, { paths: [process.cwd()] })
    const loaded = require(resolved)

    return loaded && loaded.default ? loaded.default : loaded
  }

  /**
   * @param {Function|Object} collector - Collector class or instance
   * @param {Object} [params={}] - `{ interval, key, opts }`
   * @returns {string} Key the collector was registered under
   */
  addCollector (collector, { interval, key, opts = {} } = {}) {
    const Collector = collector
    const instance = typeof Collector === 'function'
      ? new Collector({ registry: this.registry, caller: this.caller, ...opts })
      : Collector

    if (typeof instance.collect !== 'function') {
      throw new Error('ERR_COLLECTOR_COLLECT_NOT_A_FUNCTION')
    }

    const id = key || instance.name
    const every = Number(interval)

    if (!Number.isFinite(every) || every <= 0) {
      throw new Error(`ERR_COLLECTOR_INTERVAL_INVALID: ${id}`)
    }

    this.removeCollector(id)

    const timer = setInterval(() => this._runCollector(id), every)
    this.collectors.set(id, { instance, timer, interval: every })

    return id
  }

  /**
   * @param {string} key - Key returned by `addCollector`
   * @returns {boolean} True when a collector was removed
   */
  async removeCollector (key) {
    const entry = this.collectors.get(key)
    if (!entry) return false

    clearInterval(entry.timer)
    this.collectors.delete(key)

    try {
      if (entry.instance && typeof entry.instance.close === 'function') {
        await entry.instance.close()
      }
    } catch (err) {
      console.error(`Collector '${key}' close failed: ${err.message}`)
    }

    return true
  }

  /**
   * @param {string} key - Collector key
   * @private
   */
  async _runCollector (key) {
    const entry = this.collectors.get(key)
    if (!entry || !this.isEnabled) return

    try {
      await entry.instance.collect()
    } catch (err) {
      console.error(`Collector '${key}' failed: ${err.message}`)
    }
  }

  /**
   * @private
   */
  async _stopCollectors () {
    for (const [key, entry] of Array.from(this.collectors.entries())) {
      clearInterval(entry.timer)
      this.collectors.delete(key)

      try {
        await entry.instance.close()
      } catch (err) {
        console.error(`Collector '${key}' close failed: ${err.message}`)
      }
    }
  }

  /**
   * @private
   */
  _flush () {
    if (!this.isEnabled || !this.exporter) return

    const allMetrics = this.registry.getAllMetrics()
    if (Object.keys(allMetrics).length === 0) return

    this.exporter.sendMetrics(allMetrics)
    this.registry.clearGauges()
  }

  /**
   * Record a gauge metric (current value)
   * @param {string} name - Metric name
   * @param {number} value - Metric value
   * @param {Object} labels - Metric labels (app and instance are added automatically)
   * @param {Object} options - Metric options (help, type)
   */
  recordGauge (name, value, labels = {}, options = {}) {
    this.registry.setGauge(name, value, labels, options)
  }

  /**
   * Record a counter metric (incrementing value)
   * @param {string} name - Metric name
   * @param {number} value - Value to increment by (default: 1)
   * @param {Object} labels - Metric labels (app and instance are added automatically)
   * @param {Object} options - Metric options (help, type)
   */
  recordCounter (name, value = 1, labels = {}, options = {}) {
    this.registry.incrementCounter(name, value, labels, options)
  }

  /**
   * Record a histogram metric (observation value)
   * @param {string} name - Metric name
   * @param {number} value - Observed value
   * @param {Object} labels - Metric labels (app and instance are added automatically)
   * @param {Object} options - Metric options (help, type)
   */
  recordHistogram (name, value, labels = {}, options = {}) {
    this.registry.recordHistogram(name, value, labels, options)
  }

  /**
   * Start a timer and return a function to end it
   * @param {string} name - Metric name (optional - if not provided, just returns duration)
   * @param {Object} labels - Metric labels (app and instance are added automatically)
   * @param {Object} options - Metric options (help, type)
   * @returns {Function} Function to call to record the duration (or just return it if no name)
   */
  startTimer (name, labels = {}, options = {}) {
    const start = Date.now()
    return () => {
      const duration = (Date.now() - start) / 1000
      if (name) {
        this.recordHistogram(name, duration, labels, options)
      }
      return duration
    }
  }
}

MetricsFacility.BaseCollector = BaseCollector
module.exports = MetricsFacility
