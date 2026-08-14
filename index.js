'use strict'

const Base = require('@bitfinex/bfx-facs-base')
const async = require('async')
const SystemMetricsCollector = require('./lib/system-metrics-collector')
const MetricsHyperswarmExporter = require('./lib/metrics-hyperswarm-exporter')
const MetricsRegistry = require('./lib/metrics-registry')

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
    this.systemCollector = new SystemMetricsCollector()
    this.exporter = null
    this.isEnabled = false

    this.systemMetricsTimer = null
    this.flushTimer = null
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

        if (this.conf.collectSystemMetrics === true) {
          const interval = this.conf.systemMetricsInterval || 10000
          this.systemMetricsTimer = setInterval(
            () => this._collectSystemMetrics(),
            interval
          )
        }

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
        if (this.systemMetricsTimer) {
          clearInterval(this.systemMetricsTimer)
          this.systemMetricsTimer = null
        }
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
   * Collect system metrics
   * @private
   */
  _collectSystemMetrics () {
    if (!this.isEnabled) return

    const metrics = this.systemCollector.collect()

    Object.entries(metrics.memory).forEach(([name, value]) => {
      this.recordGauge(name, value)
    })

    Object.entries(metrics.cpu).forEach(([name, value]) => {
      const type = name.includes('_total') ? 'counter' : 'gauge'
      if (type === 'counter') {
        this.recordCounter(name, value)
      } else {
        this.recordGauge(name, value)
      }
    })

    Object.entries(metrics.system).forEach(([name, value]) => {
      this.recordGauge(name, value)
    })

    Object.entries(metrics.process).forEach(([name, value]) => {
      if (typeof value === 'number') {
        this.recordGauge(name, value)
      }
    })
  }

  /**
   * Flush metrics to exporter
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

  /**
   * Parse a metrics exposition document and merge every sample into the
   * registry, attaching extra labels (e.g. `{ job_id, endpoint, model, replica }`).
   *
   * This is a passthrough for scraping another exporter (e.g. vLLM's native
   * `/metrics`, which uses this text exposition format). Samples are recorded
   * as gauges holding their exact current value, so re-ingesting each flush
   * cycle keeps values fresh. Histogram and summary component samples
   * (`_bucket`/`_sum`/`_count`/`quantile`) are carried through as individual
   * named series; their family-level `# TYPE` is not reconstructed.
   * Non-finite values (`+Inf`/`-Inf`/`NaN`) are skipped.
   *
   * @param {string} text - Metrics exposition text
   * @param {Object} [extraLabels={}] - Labels merged into every sample
   */
  ingestExposition (text, extraLabels = {}) {
    if (!text || typeof text !== 'string') return

    const helps = {}

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue

      if (line.startsWith('#')) {
        const meta = line.match(/^#\s+(HELP|TYPE)\s+(\S+)\s+(.*)$/)
        if (meta && meta[1] === 'HELP') helps[meta[2]] = meta[3].trim()
        continue
      }

      const sample = this._parseExpositionSample(line)
      if (!sample) continue

      this.registry.setGauge(
        sample.name,
        sample.value,
        { ...sample.labels, ...extraLabels },
        { help: helps[sample.name] }
      )
    }
  }

  /**
   * Parse a single metrics exposition sample line into name/labels/value.
   *
   * @param {string} line - Trimmed non-comment exposition line
   * @returns {{ name: string, labels: Object, value: number }|null} Parsed sample or null
   * @private
   */
  _parseExpositionSample (line) {
    const braceIdx = line.indexOf('{')
    let name
    let labels = {}
    let valueToken

    if (braceIdx === -1) {
      const parts = line.split(/\s+/)
      name = parts[0]
      valueToken = parts[1]
    } else {
      const closeIdx = line.lastIndexOf('}')
      if (closeIdx === -1) return null
      name = line.slice(0, braceIdx).trim()
      labels = this._parseExpositionLabels(line.slice(braceIdx + 1, closeIdx))
      valueToken = line.slice(closeIdx + 1).trim().split(/\s+/)[0]
    }

    const value = Number(valueToken)
    if (!name || !Number.isFinite(value)) return null

    return { name, labels, value }
  }

  /**
   * Parse the label body of an exposition sample (the content between braces).
   *
   * @param {string} body - Label body, e.g. `le="0.1",model="x"`
   * @returns {Object} Label key/value pairs
   * @private
   */
  _parseExpositionLabels (body) {
    const labels = {}
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g
    let m

    while ((m = re.exec(body)) !== null) {
      labels[m[1]] = m[2]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\')
    }

    return labels
  }
}

module.exports = MetricsFacility
