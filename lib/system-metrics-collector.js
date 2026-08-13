'use strict'

const os = require('os')

class SystemMetricsCollector {
  constructor () {
    this.lastCpuUsage = null
    this.lastCpuTime = null
  }

  /**
   * Collect all system metrics for the current process
   * @returns {Object} Object containing memory, cpu, system, and process metrics
   */
  collect () {
    return {
      memory: this._collectMemoryMetrics(),
      cpu: this._collectCpuMetrics(),
      system: this._collectSystemMetrics(),
      process: this._collectProcessMetrics()
    }
  }

  /**
   * Collect memory-related metrics
   * @returns {Object} Memory metrics
   * @private
   */
  _collectMemoryMetrics () {
    const mem = process.memoryUsage()

    return {
      process_resident_memory_bytes: mem.rss,
      process_heap_total_bytes: mem.heapTotal,
      process_heap_used_bytes: mem.heapUsed,
      process_external_memory_bytes: mem.external,
      process_array_buffers_bytes: mem.arrayBuffers || 0,

      system_free_memory_bytes: os.freemem(),
      system_total_memory_bytes: os.totalmem(),
      system_memory_usage_ratio: 1 - (os.freemem() / os.totalmem())
    }
  }

  /**
   * Collect CPU-related metrics
   * @returns {Object} CPU metrics
   * @private
   */
  _collectCpuMetrics () {
    const currentUsage = process.cpuUsage()
    const currentTime = Date.now()

    let cpuPercent = 0

    if (this.lastCpuUsage && this.lastCpuTime) {
      const elapsedTime = currentTime - this.lastCpuTime
      const userDiff = currentUsage.user - this.lastCpuUsage.user
      const systemDiff = currentUsage.system - this.lastCpuUsage.system

      cpuPercent = 100 * (userDiff + systemDiff) / (elapsedTime * 1000)
    }

    this.lastCpuUsage = currentUsage
    this.lastCpuTime = currentTime

    return {
      process_cpu_user_seconds_total: currentUsage.user / 1000000,
      process_cpu_system_seconds_total: currentUsage.system / 1000000,
      process_cpu_usage_percent: cpuPercent
    }
  }

  /**
   * Collect system-wide metrics
   * @returns {Object} System metrics
   * @private
   */
  _collectSystemMetrics () {
    const cpus = os.cpus()
    const loadAvg = os.loadavg()

    return {
      system_cpu_count: cpus.length,
      system_load_average_1m: loadAvg[0],
      system_load_average_5m: loadAvg[1],
      system_load_average_15m: loadAvg[2]
    }
  }

  /**
   * Collect process-related metrics
   * @returns {Object} Process metrics
   * @private
   */
  _collectProcessMetrics () {
    return {
      process_uptime_seconds: process.uptime(),
      process_pid: process.pid,
      nodejs_version: process.version
    }
  }
}

module.exports = SystemMetricsCollector
