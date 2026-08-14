'use strict'

const os = require('os')
const BaseCollector = require('./base-collector')

class SystemMetricsCollector extends BaseCollector {
  constructor (params) {
    super(params)

    this.lastCpuUsage = null
    this.lastCpuTime = null
  }

  collect () {
    this._collectMemory()
    this._collectCpu()
    this._collectHost()
    this._collectProcess()
  }

  /**
   * Process and host memory gauges.
   *
   * @private
   */
  _collectMemory () {
    const mem = process.memoryUsage()

    this.gauge('process_resident_memory_bytes', mem.rss)
    this.gauge('process_heap_total_bytes', mem.heapTotal)
    this.gauge('process_heap_used_bytes', mem.heapUsed)
    this.gauge('process_external_memory_bytes', mem.external)
    this.gauge('process_array_buffers_bytes', mem.arrayBuffers || 0)

    this.gauge('system_free_memory_bytes', os.freemem())
    this.gauge('system_total_memory_bytes', os.totalmem())
    this.gauge('system_memory_usage_ratio', 1 - (os.freemem() / os.totalmem()))
  }

  /**
   * CPU counters and the derived usage percentage.
   *
   * `process.cpuUsage()` returns cumulative microseconds, so the counters are
   * incremented by the difference since the previous collection. The first
   * collection establishes a baseline and reports no increment.
   *
   * @private
   */
  _collectCpu () {
    const usage = process.cpuUsage()
    const now = Date.now()

    if (this.lastCpuUsage && this.lastCpuTime) {
      const elapsedMs = now - this.lastCpuTime
      const userDelta = usage.user - this.lastCpuUsage.user
      const systemDelta = usage.system - this.lastCpuUsage.system

      this.counter('process_cpu_user_seconds_total', userDelta / 1000000)
      this.counter('process_cpu_system_seconds_total', systemDelta / 1000000)

      const percent = elapsedMs > 0
        ? 100 * (userDelta + systemDelta) / (elapsedMs * 1000)
        : 0
      this.gauge('process_cpu_usage_percent', percent)
    } else {
      this.gauge('process_cpu_usage_percent', 0)
    }

    this.lastCpuUsage = usage
    this.lastCpuTime = now
  }

  /**
   * Host CPU count and load averages.
   *
   * @private
   */
  _collectHost () {
    const loadAvg = os.loadavg()

    this.gauge('system_cpu_count', os.cpus().length)
    this.gauge('system_load_average_1m', loadAvg[0])
    this.gauge('system_load_average_5m', loadAvg[1])
    this.gauge('system_load_average_15m', loadAvg[2])
  }

  /**
   * @private
   */
  _collectProcess () {
    this.gauge('process_uptime_seconds', process.uptime())
    this.gauge('process_pid', process.pid)
  }
}

module.exports = SystemMetricsCollector
