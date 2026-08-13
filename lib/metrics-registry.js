'use strict'

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

/**
 * Normalise histogram bucket bounds: finite numbers only, ascending, de-duped.
 * The implicit `+Inf` bucket is added at exposition time, not stored here.
 *
 * @param {Array<number>} [buckets] - Requested upper bounds
 * @returns {Array<number>} Sorted, de-duplicated bounds
 */
function resolveBuckets (buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return [...DEFAULT_BUCKETS]

  const cleaned = buckets
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)

  const unique = cleaned.filter((n, i) => i === 0 || n !== cleaned[i - 1])
  return unique.length ? unique : [...DEFAULT_BUCKETS]
}

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
    let metric = this.metrics.get(key)

    if (!metric || metric.type !== 'histogram') {
      const bounds = resolveBuckets(options.buckets)
      metric = {
        name,
        labels,
        type: 'histogram',
        help: options.help,
        bounds,
        counts: new Array(bounds.length).fill(0),
        sum: 0,
        count: 0,
        timestamp: Date.now()
      }
      this.metrics.set(key, metric)
    }

    for (let i = 0; i < metric.bounds.length; i++) {
      if (value <= metric.bounds[i]) metric.counts[i] += 1
    }

    metric.sum += value
    metric.count += 1
    metric.timestamp = Date.now()
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

    for (const metric of this.metrics.values()) {
      if (!result[metric.name]) {
        result[metric.name] = {
          type: metric.type,
          help: metric.help,
          datapoints: []
        }
      }

      if (metric.type === 'histogram') {
        result[metric.name].datapoints.push({
          labels: metric.labels,
          sum: metric.sum,
          count: metric.count,
          buckets: (metric.bounds || []).map((le, i) => ({ le, count: metric.counts[i] }))
        })
      } else {
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
