'use strict'

/**
 * Base class for metrics collectors.
 *
 * A collector owns both *what* it samples and *how* each sample is typed: it
 * writes into the registry itself rather than returning a shape the facility has
 * to interpret. Adding a collector therefore requires no change to the facility,
 * and metric types are declared by the collector instead of being inferred from
 * the metric name.
 *
 * Subclasses implement `collect()`. It may be sync or async; the facility awaits
 * it and logs-and-skips a tick that throws, so one failing collector cannot stop
 * the others.
 *
 * @example
 * class QueueDepthCollector extends BaseCollector {
 *   collect () {
 *     this.gauge('queue_depth', this.opts.queue.length, { queue: this.opts.name })
 *   }
 * }
 */
class BaseCollector {
  /**
   * @param {Object} params - Collector parameters
   * @param {Object} params.registry - The `MetricsRegistry` to write into
   * @param {Object} [params.caller] - The worker that owns the facility. Lets a
   *   collector reach runtime dependencies (a service handle, a connection) that
   *   JSON config cannot express, so it can still be declared in config
   * @param {...*} params.opts - Collector-specific options, available as `this.opts`
   */
  constructor ({ registry, caller, ...opts } = {}) {
    if (!registry) throw new Error('ERR_COLLECTOR_REGISTRY_REQUIRED')

    this.registry = registry
    this.caller = caller
    this.opts = opts
  }

  /**
   * Identifier used in scheduling keys and error messages.
   *
   * @returns {string} Collector name
   */
  get name () {
    return this.constructor.name
  }

  /**
   * Sample and record. Called by the facility on the configured interval.
   *
   * @returns {Promise<void>|void}
   */
  collect () {
    throw new Error(`ERR_COLLECTOR_COLLECT_NOT_IMPLEMENTED: ${this.name}`)
  }

  /**
   * Record a gauge — a value that can go up or down, valid at collection time.
   *
   * @param {string} name - Metric name
   * @param {number} value - Current value
   * @param {Object} [labels={}] - Metric labels
   * @param {Object} [options={}] - Metric options (`help`)
   */
  gauge (name, value, labels = {}, options = {}) {
    this.registry.setGauge(name, value, labels, options)
  }

  /**
   * Record a counter increment. Pass the **delta** since the last collection, not
   * a cumulative total — the registry adds what it is given.
   *
   * @param {string} name - Metric name
   * @param {number} [value=1] - Amount to add
   * @param {Object} [labels={}] - Metric labels
   * @param {Object} [options={}] - Metric options (`help`)
   */
  counter (name, value = 1, labels = {}, options = {}) {
    this.registry.incrementCounter(name, value, labels, options)
  }

  /**
   * Record a histogram observation.
   *
   * @param {string} name - Metric name
   * @param {number} value - Observed value
   * @param {Object} [labels={}] - Metric labels
   * @param {Object} [options={}] - Metric options (`help`, `buckets`)
   */
  histogram (name, value, labels = {}, options = {}) {
    this.registry.recordHistogram(name, value, labels, options)
  }

  /**
   * Optional teardown hook, awaited when the facility stops.
   *
   * @returns {Promise<void>|void}
   */
  close () {}
}

module.exports = BaseCollector
