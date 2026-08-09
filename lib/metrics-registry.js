'use strict'

class MetricsRegistry {
  constructor () {
    this.metrics = new Map()
  }

  /**
   * Set a gauge metric (current value)
   * @param {string} name - Metric name
   * @param {number} value - Metric value
   * @param {Object} labels - Metric labels
   * @param {Object} options - Metric options (help, type)
   */
  setGauge (name, value, labels = {}, options = {}) {
    const key = this._getKey(name, labels)
    this.metrics.set(key, {
      name,
      value,
      labels,
      type: 'gauge',
      help: options.help,
      timestamp: Date.now()
    })
  }

  /**
   * Increment a counter metric (accumulating value)
   * @param {string} name - Metric name
   * @param {number} value - Value to increment by
   * @param {Object} labels - Metric labels
   * @param {Object} options - Metric options (help, type)
   */
  incrementCounter (name, value = 1, labels = {}, options = {}) {
    const key = this._getKey(name, labels)
    const existing = this.metrics.get(key)

    if (existing) {
      existing.value += value
      existing.timestamp = Date.now()
    } else {
      this.metrics.set(key, {
        name,
        value,
        labels,
        type: 'counter',
        help: options.help,
        timestamp: Date.now()
      })
    }
  }

  /**
   * Record a histogram metric (observation value)
   * Multiple observations can be recorded for the same label combination
   * @param {string} name - Metric name
   * @param {number} value - Observed value
   * @param {Object} labels - Metric labels
   * @param {Object} options - Metric options (help, type)
   */
  recordHistogram (name, value, labels = {}, options = {}) {
    const key = this._getKey(name, labels)

    if (this.metrics.has(key)) {
      // Accumulate observations for same label combination
      const existing = this.metrics.get(key)
      if (!Array.isArray(existing.values)) {
        existing.values = [existing.value]
        delete existing.value
      }
      existing.values.push(value)
      existing.timestamp = Date.now()
    } else {
      // First observation
      this.metrics.set(key, {
        name,
        values: [value],
        labels,
        type: 'histogram',
        help: options.help,
        timestamp: Date.now()
      })
    }
  }

  /**
   * Get all metrics for export
   * Groups data points by metric name with type metadata
   * For histograms, aggregates observations into sum and count
   * @returns {Object} Metrics grouped by name with type and data points
   * Example:
   * {
   *   http_requests_total: {
   *     type: 'counter',
   *     help: 'Total HTTP requests',
   *     datapoints: [
   *       { labels: { app: 'x', path: '/api/users' }, value: 10 },
   *       { labels: { app: 'x', path: '/api/jobs' }, value: 5 }
   *     ]
   *   },
   *   http_request_duration_seconds: {
   *     type: 'histogram',
   *     help: 'Request duration',
   *     datapoints: [
   *       { labels: { path: '/api/users' }, sum: 1.5, count: 3 }
   *     ]
   *   }
   * }
   */
  getAllMetrics () {
    const result = {}

    // Group data points by metric name
    for (const metric of this.metrics.values()) {
      if (!result[metric.name]) {
        result[metric.name] = {
          type: metric.type,
          help: metric.help,
          datapoints: []
        }
      }

      // For histograms, aggregate observations into sum and count
      if (metric.type === 'histogram' && metric.values) {
        const sum = metric.values.reduce((acc, val) => acc + val, 0)
        const count = metric.values.length

        result[metric.name].datapoints.push({
          labels: metric.labels,
          sum,
          count
        })
      } else {
        // For gauges and counters
        result[metric.name].datapoints.push({
          labels: metric.labels,
          value: metric.value
        })
      }
    }

    return result
  }

  /**
   * Clear gauge metrics (after flush)
   * Counters are kept to accumulate values
   */
  clearGauges () {
    for (const [key, metric] of this.metrics.entries()) {
      if (metric.type === 'gauge') {
        this.metrics.delete(key)
      }
    }
  }

  /**
   * Clear all metrics
   */
  clear () {
    this.metrics.clear()
  }

  /**
   * Generate a unique key for a metric based on name and labels
   * @param {string} name - Metric name
   * @param {Object} labels - Metric labels
   * @returns {string} Unique key
   * @private
   */
  _getKey (name, labels) {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',')

    return labelStr ? `${name}{${labelStr}}` : name
  }
}

module.exports = MetricsRegistry
