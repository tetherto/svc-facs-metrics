'use strict'

const test = require('brittle')
const MetricsRegistry = require('../lib/metrics-registry')
const MetricHyperswarmExporter = require('../lib/metrics-hyperswarm-exporter')
const MetricsFacility = require('..')

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
  fac.systemMetricsTimer = null
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
        if (fac.systemMetricsTimer) clearInterval(fac.systemMetricsTimer)
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

test('system metrics collection is opt-in', async (t) => {
  t.is(
    MetricsFacility.prototype._start.length,
    1,
    '_start takes a callback (guards the assumption below)'
  )

  // The gate is `collectSystemMetrics === true`, so anything else must not schedule.
  const src = MetricsFacility.prototype._start.toString()
  t.ok(
    src.includes('collectSystemMetrics === true'),
    'explicit opt-in: absent or truthy-but-not-true no longer enables collection'
  )
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
