'use strict'

const test = require('brittle')
const MetricsRegistry = require('../lib/metrics-registry')
const MetricHyperswarmExporter = require('../lib/metrics-hyperswarm-exporter')
const MetricsFacility = require('..')
const SystemMetricsCollector = require('../lib/collectors/system-metrics-collector')

/**
 * A facility instance with the boot machinery stubbed out, so the flush and stop
 * paths can be exercised without a Hyperswarm connection.
 *
 * @param {Object} [conf={}] - Facility config
 * @returns {Object} `{ fac, sent }` where `sent` collects each exporter payload
 */
function stubFacility (conf = {}) {
  const sent = []
  const fac = Object.create(MetricsFacility.prototype)

  fac.conf = conf
  fac.registry = new MetricsRegistry({ maxSeries: conf.maxSeries })
  fac.isEnabled = true
  fac.collectors = new Map()
  fac.flushTimer = null
  fac.exporter = {
    sendMetrics: (metrics) => sent.push(metrics),
    stop: async () => {}
  }

  return { fac, sent }
}

test('the final flush on stop still carries gauge values', async (t) => {
  const { fac, sent } = stubFacility()
  fac.recordGauge('gpu_utilization_pct', 42)

  await new Promise((resolve, reject) => {
    // super._stop is bfx-facs-base; bypass it and run only this facility's teardown.
    const series = require('async').series
    series([
      async () => {
        await fac._stopCollectors()
        if (fac.flushTimer) clearInterval(fac.flushTimer)
        fac._flush()
        await fac.exporter.stop()
      }
    ], (err) => (err ? reject(err) : resolve()))
  })

  t.is(sent.length, 1, 'one payload was sent on shutdown')
  const names = Object.keys(sent[0])
  t.ok(names.includes('gpu_utilization_pct'), 'the gauge survived to the final flush')
  t.is(sent[0].gpu_utilization_pct.datapoints[0].value, 42, 'with its last value')
})

test('_flush clears gauges after sending, and counters persist', async (t) => {
  const { fac, sent } = stubFacility()

  fac.recordGauge('gpu_temp_c', 61)
  fac.recordCounter('inference_requests_total', 3)
  fac._flush()

  t.is(Object.keys(sent[0]).length, 2, 'gauge and counter both sent')

  fac._flush()
  t.is(sent.length, 2, 'second flush still sends')
  t.absent(Object.keys(sent[1]).includes('gpu_temp_c'), 'gauge was cleared after the first send')
  t.ok(Object.keys(sent[1]).includes('inference_requests_total'), 'counter persists across flushes')
})

test('a failed send does not accumulate gauges', async (t) => {
  const { fac } = stubFacility()
  fac.exporter.sendMetrics = () => {} // simulate "not authenticated / no connection"

  for (let i = 0; i < 50; i++) {
    fac.recordGauge('gpu_utilization_pct', i, { gpu: '0' })
    fac._flush()
  }

  t.is(fac.registry.metrics.size, 0, 'gauges are dropped, not buffered, while disconnected')
})

test('nothing is collected unless listed in collectors', async (t) => {
  for (const conf of [{}, { collectors: [] }, { collectSystemMetrics: true }]) {
    const { fac } = stubFacility(conf)
    fac._startConfiguredCollectors()
    t.is(fac.collectors.size, 0, `no collection for ${JSON.stringify(conf)}`)
  }
})

test('maxSeries caps cardinality without affecting existing series', async (t) => {
  const registry = new MetricsRegistry({ maxSeries: 3 })

  registry.setGauge('m', 1, { id: 'a' })
  registry.setGauge('m', 1, { id: 'b' })
  registry.setGauge('m', 1, { id: 'c' })
  t.is(registry.metrics.size, 3, 'fills up to the cap')

  registry.setGauge('m', 1, { id: 'd' })
  t.is(registry.metrics.size, 3, 'new series past the cap are dropped')

  registry.setGauge('m', 99, { id: 'a' })
  const all = registry.getAllMetrics()
  const a = all.m.datapoints.find((d) => d.labels.id === 'a')
  t.is(a.value, 99, 'existing series keep updating')

  registry.incrementCounter('c', 1, { id: 'z' })
  registry.recordHistogram('h', 1, { id: 'z' })
  t.is(registry.metrics.size, 3, 'counters and histograms respect the cap too')
})

test('maxSeries is off unless configured', async (t) => {
  const registry = new MetricsRegistry()
  for (let i = 0; i < 200; i++) registry.setGauge('m', 1, { id: String(i) })

  t.is(registry.maxSeries, null, 'no cap by default')
  t.is(registry.metrics.size, 200, 'unbounded when unset')
})

test('the connection handler is registered once, not per connect attempt', async (t) => {
  const exporter = new MetricHyperswarmExporter({
    app: 'test',
    topic: '@test/topic',
    secretKey: 'secret'
  })

  const handlers = []
  exporter.swarm = {
    on: (ev, fn) => { if (ev === 'connection') handlers.push(fn) },
    join: () => ({ flushed: async () => {} })
  }

  // start() registers the handler; repeated connect attempts must not add more.
  exporter.swarm.on('connection', (socket) => exporter._onConnection(socket))
  await exporter._connectToMonitor()
  await exporter._connectToMonitor()

  t.is(handlers.length, 1, 'exactly one connection listener, so metrics are not double-sent')
})

test('an errored socket is destroyed and state is reset', async (t) => {
  const exporter = new MetricHyperswarmExporter({
    app: 'test',
    topic: '@test/topic',
    secretKey: 'secret'
  })
  exporter._authenticate = () => { exporter.isAuthenticated = true }

  const events = {}
  let destroyed = false
  const socket = {
    on: (ev, fn) => { events[ev] = fn },
    write: () => {},
    destroy: () => { destroyed = true }
  }

  exporter._onConnection(socket)
  t.is(exporter.connection, socket, 'connection adopted')
  t.ok(exporter.isAuthenticated, 'authentication attempted on connect')

  events.error(new Error('boom'))

  t.ok(destroyed, 'the socket is destroyed rather than left half-open')
  t.is(exporter.connection, null, 'connection reference cleared')
  t.absent(exporter.isAuthenticated, 'authentication state reset')
})

test('a stale socket closing does not clear a newer connection', async (t) => {
  const exporter = new MetricHyperswarmExporter({
    app: 'test',
    topic: '@test/topic',
    secretKey: 'secret'
  })
  exporter._authenticate = () => {}

  const mk = () => {
    const events = {}
    return { events, sock: { on: (ev, fn) => { events[ev] = fn }, write: () => {}, destroy: () => {} } }
  }

  const first = mk()
  const second = mk()

  exporter._onConnection(first.sock)
  exporter._onConnection(second.sock) // reconnect
  first.events.close() // the old socket reports closure late

  t.is(exporter.connection, second.sock, 'the live connection is preserved')
})

test('BaseCollector requires a registry and forces collect() to be implemented', async (t) => {
  const BaseCollector = MetricsFacility.BaseCollector

  t.exception(() => new BaseCollector({}), /ERR_COLLECTOR_REGISTRY_REQUIRED/, 'registry is required')

  const bare = new BaseCollector({ registry: new MetricsRegistry() })
  t.exception(() => bare.collect(), /ERR_COLLECTOR_COLLECT_NOT_IMPLEMENTED/, 'collect() must be overridden')
})

test('a collector writes to the registry and declares its own types', async (t) => {
  const registry = new MetricsRegistry()

  class QueueCollector extends MetricsFacility.BaseCollector {
    collect () {
      this.gauge('queue_depth', 7, { queue: this.opts.name })
      this.counter('queue_processed_total', 2, { queue: this.opts.name })
      this.histogram('queue_wait_seconds', 0.4, { queue: this.opts.name })
    }
  }

  new QueueCollector({ registry, name: 'jobs' }).collect()
  const all = registry.getAllMetrics()

  t.is(all.queue_depth.type, 'gauge', 'gauge declared, not inferred')
  t.is(all.queue_processed_total.type, 'counter', 'counter declared despite no name convention')
  t.is(all.queue_wait_seconds.type, 'histogram', 'histogram declared')
  t.is(all.queue_depth.datapoints[0].labels.queue, 'jobs', 'constructor opts reach the collector')
})

test('SystemMetricsCollector increments CPU counters by the delta, not the total', async (t) => {
  const registry = new MetricsRegistry()
  const collector = new SystemMetricsCollector({ registry })

  collector.collect() // baseline: no counter increment yet
  t.absent(
    registry.getAllMetrics().process_cpu_user_seconds_total,
    'first collection only establishes a baseline'
  )

  // Two further collections with a known cumulative sequence.
  let fake = { user: 5_000_000, system: 1_000_000 }
  collector.lastCpuUsage = { user: 4_000_000, system: 0 }
  collector.lastCpuTime = Date.now() - 1000
  const realCpuUsage = process.cpuUsage
  process.cpuUsage = () => fake

  try {
    collector.collect()
    let user = registry.getAllMetrics().process_cpu_user_seconds_total.datapoints[0].value
    t.is(Number(user.toFixed(3)), 1, 'first increment is the delta (5s - 4s), not the 5s total')

    fake = { user: 6_000_000, system: 1_000_000 }
    collector.collect()
    user = registry.getAllMetrics().process_cpu_user_seconds_total.datapoints[0].value
    t.is(Number(user.toFixed(3)), 2, 'accumulates to the real total (6s - 4s), not 11s')
  } finally {
    process.cpuUsage = realCpuUsage
  }
})

test('SystemMetricsCollector records only numeric samples', async (t) => {
  const registry = new MetricsRegistry()
  new SystemMetricsCollector({ registry }).collect()

  const all = registry.getAllMetrics()
  t.absent(all.nodejs_version, 'the version string is not recorded as a metric')
  t.ok(all.process_uptime_seconds, 'numeric process metrics are')
  t.ok(all.system_load_average_1m, 'host metrics are')

  for (const [name, metric] of Object.entries(all)) {
    for (const dp of metric.datapoints) {
      const v = dp.value !== undefined ? dp.value : dp.sum
      t.ok(typeof v === 'number' && Number.isFinite(v), `${name} is a finite number`)
    }
  }
})

test('addCollector schedules, removeCollector unschedules', async (t) => {
  const { fac } = stubFacility()
  let ticks = 0

  class Ticker extends MetricsFacility.BaseCollector {
    collect () { ticks++; this.gauge('ticks', ticks) }
  }

  const key = fac.addCollector(Ticker, { interval: 10, key: 'ticker' })
  t.is(key, 'ticker', 'returns the registration key')
  t.is(fac.collectors.size, 1, 'scheduled')

  await new Promise((resolve) => setTimeout(resolve, 45))
  t.ok(ticks >= 2, `collected repeatedly (${ticks} ticks)`)

  t.ok(fac.removeCollector('ticker'), 'removed')
  t.is(fac.collectors.size, 0, 'unscheduled')

  const seen = ticks
  await new Promise((resolve) => setTimeout(resolve, 30))
  t.is(ticks, seen, 'no further collection after removal')

  await fac._stopCollectors()
})

test('addCollector accepts an instance for runtime-dependent collectors', async (t) => {
  const { fac } = stubFacility()
  let fetched = 0

  class InjectedCollector extends MetricsFacility.BaseCollector {
    collect () { fetched++; this.gauge('injected', fetched) }
  }

  // A collector needing a live dependency cannot come from JSON config.
  const instance = new InjectedCollector({ registry: fac.registry, conn: { live: true } })
  fac.addCollector(instance, { interval: 10, key: 'injected' })

  await new Promise((resolve) => setTimeout(resolve, 35))
  t.ok(fetched >= 2, 'the pre-built instance is scheduled and collected')

  await fac._stopCollectors()
  t.is(fac.collectors.size, 0, 'stopped')
})

test('a failing collector is isolated', async (t) => {
  const { fac } = stubFacility()
  let good = 0

  class Boom extends MetricsFacility.BaseCollector {
    collect () { throw new Error('boom') }
  }
  class Fine extends MetricsFacility.BaseCollector {
    collect () { good++ }
  }

  fac.addCollector(Boom, { interval: 10, key: 'boom' })
  fac.addCollector(Fine, { interval: 10, key: 'fine' })

  await new Promise((resolve) => setTimeout(resolve, 45))

  t.ok(good >= 2, 'the healthy collector keeps running despite the broken one')
  t.is(fac.collectors.size, 2, 'neither is unscheduled by a failure')

  await fac._stopCollectors()
})

test('addCollector rejects an unusable interval or shape', async (t) => {
  const { fac } = stubFacility()

  class Ok extends MetricsFacility.BaseCollector { collect () {} }

  t.exception(() => fac.addCollector(Ok, { interval: 0 }), /ERR_COLLECTOR_INTERVAL_INVALID/, 'zero interval')
  t.exception(() => fac.addCollector(Ok, {}), /ERR_COLLECTOR_INTERVAL_INVALID/, 'missing interval')
  t.exception(
    () => fac.addCollector({ notACollector: true }, { interval: 10 }),
    /ERR_COLLECTOR_COLLECT_NOT_A_FUNCTION/,
    'object without collect()'
  )
})

test('_resolveCollector resolves module paths and rejects junk', async (t) => {
  const { fac } = stubFacility()
  const abs = require('path').join(__dirname, '..', 'lib', 'collectors', 'system-metrics-collector')

  t.is(fac._resolveCollector(abs), SystemMetricsCollector, 'absolute path')
  t.is(
    fac._resolveCollector('./lib/collectors/system-metrics-collector'),
    SystemMetricsCollector,
    'path relative to the worker cwd'
  )

  class Direct extends MetricsFacility.BaseCollector { collect () {} }
  t.is(fac._resolveCollector(Direct), Direct, 'a class passes through')

  t.exception(() => fac._resolveCollector(''), /ERR_COLLECTOR_REF_INVALID/, 'empty ref')
  t.exception(() => fac._resolveCollector(null), /ERR_COLLECTOR_REF_INVALID/, 'null ref')
  t.exception(() => fac._resolveCollector('system-metrics-collector'), /Cannot find module/, 'bare keywords are not special-cased')
})

test('config-driven collectors start from a path', async (t) => {
  const abs = require('path').join(__dirname, '..', 'lib', 'collectors', 'system-metrics-collector')

  const { fac } = stubFacility({ collectors: [{ collector: abs, interval: 5000 }] })
  fac._startConfiguredCollectors()
  t.is(fac.collectors.size, 1, 'collectors list is honoured')
  t.ok(fac.collectors.has(abs), 'keyed by its config reference')

  const disabled = stubFacility({ collectors: [{ collector: abs, interval: 5000, enabled: false }] }).fac
  disabled._startConfiguredCollectors()
  t.is(disabled.collectors.size, 0, 'per-entry enabled:false is respected')

  const noInterval = stubFacility({ collectors: [{ collector: abs }] }).fac
  noInterval._startConfiguredCollectors()
  t.is(noInterval.collectors.size, 0, 'an entry without an interval is skipped, not defaulted')

  await fac._stopCollectors()
})

test('an unresolvable collector does not prevent the others from starting', async (t) => {
  const { fac } = stubFacility({
    collectors: [
      { collector: './does-not-exist', interval: 5000 },
      { collector: require('path').join(__dirname, '..', 'lib', 'collectors', 'system-metrics-collector'), interval: 5000 }
    ]
  })

  fac._startConfiguredCollectors()

  t.is(fac.collectors.size, 1, 'the good collector still started')

  await fac._stopCollectors()
})

test('the shipped config example declares a collector by path', async (t) => {
  const example = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'facs', 'metrics.config.json.example'), 'utf8')
  )
  const conf = example.m0 || example

  t.ok(Array.isArray(conf.collectors), 'the example ships a collectors list')
  t.absent(conf.collectSystemMetrics, 'the removed flag is not in the example')

  const ref = conf.collectors[0].collector
  t.ok(ref.endsWith('lib/collectors/system-metrics-collector'), `default collector referenced by path: ${ref}`)
  t.ok(conf.collectors[0].interval > 0, 'with an interval')
})

test('ingestExposition is no longer facility API', async (t) => {
  t.is(
    typeof MetricsFacility.prototype.ingestExposition,
    'undefined',
    'exposition parsing moved to the consumer that owns the scrape transport'
  )
})

test('caller is injected so a collector can be declared in config', async (t) => {
  const { fac } = stubFacility()
  fac.caller = { service: { scrape: () => 'data' }, id: 'worker-1' }

  let seen = null
  class CallerCollector extends MetricsFacility.BaseCollector {
    collect () {
      seen = this.caller
      this.gauge('from_caller', 1, { worker: this.caller.id })
    }
  }

  fac.addCollector(CallerCollector, { interval: 10, key: 'caller-collector' })
  await fac._runCollector('caller-collector')

  t.is(seen, fac.caller, 'the owning worker reaches the collector')
  t.is(
    fac.registry.getAllMetrics().from_caller.datapoints[0].labels.worker,
    'worker-1',
    'so runtime state config cannot express is still usable'
  )

  await fac._stopCollectors()
})
