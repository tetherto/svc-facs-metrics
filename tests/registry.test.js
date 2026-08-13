'use strict'

const { test } = require('brittle')
const MetricsRegistry = require('../lib/metrics-registry')

test('MetricsRegistry - Counter', async function (t) {
  await t.test('should increment counter once', function (t) {
    const registry = new MetricsRegistry()

    registry.incrementCounter('http_requests_total', 1, {
      method: 'GET',
      path: '/api/users',
      status_code: '200'
    }, { help: 'Total HTTP requests' })

    const metrics = registry.getAllMetrics()

    t.ok(metrics.http_requests_total, 'should have http_requests_total metric')
    t.is(metrics.http_requests_total.type, 'counter', 'should be counter type')
    t.is(metrics.http_requests_total.help, 'Total HTTP requests', 'should have help text')
    t.is(metrics.http_requests_total.datapoints.length, 1, 'should have 1 datapoint')
    t.is(metrics.http_requests_total.datapoints[0].value, 1, 'should have value 1')
  })

  await t.test('should accumulate counter with same labels', function (t) {
    const registry = new MetricsRegistry()

    registry.incrementCounter('http_requests_total', 1, {
      method: 'GET',
      path: '/api/users'
    })

    registry.incrementCounter('http_requests_total', 3, {
      method: 'GET',
      path: '/api/users'
    })

    const metrics = registry.getAllMetrics()

    t.is(metrics.http_requests_total.datapoints.length, 1, 'should have 1 datapoint')
    t.is(metrics.http_requests_total.datapoints[0].value, 4, 'should accumulate to 4')
  })

  await t.test('should create separate counters for different labels', function (t) {
    const registry = new MetricsRegistry()

    registry.incrementCounter('http_requests_total', 1, {
      method: 'GET',
      path: '/api/users'
    })

    registry.incrementCounter('http_requests_total', 3, {
      method: 'POST',
      path: '/api/jobs'
    })

    const metrics = registry.getAllMetrics()

    t.is(metrics.http_requests_total.datapoints.length, 2, 'should have 2 datapoints')
  })
})

test('MetricsRegistry - Histogram', async function (t) {
  await t.test('should record single histogram observation', function (t) {
    const registry = new MetricsRegistry()

    registry.recordHistogram('http_request_duration_seconds', 0.234, {
      method: 'GET',
      path: '/api/users'
    }, { help: 'Request duration in seconds' })

    const metrics = registry.getAllMetrics()

    t.ok(metrics.http_request_duration_seconds, 'should have histogram metric')
    t.is(metrics.http_request_duration_seconds.type, 'histogram', 'should be histogram type')
    t.is(metrics.http_request_duration_seconds.datapoints.length, 1, 'should have 1 datapoint')
    t.is(metrics.http_request_duration_seconds.datapoints[0].sum, 0.234, 'should have correct sum')
    t.is(metrics.http_request_duration_seconds.datapoints[0].count, 1, 'should have count 1')
  })

  await t.test('should accumulate multiple histogram observations with same labels', function (t) {
    const registry = new MetricsRegistry()

    registry.recordHistogram('http_request_duration_seconds', 0.234, {
      method: 'GET',
      path: '/api/users'
    })

    registry.recordHistogram('http_request_duration_seconds', 0.156, {
      method: 'GET',
      path: '/api/users'
    })

    registry.recordHistogram('http_request_duration_seconds', 0.387, {
      method: 'GET',
      path: '/api/users'
    })

    const metrics = registry.getAllMetrics()

    t.is(metrics.http_request_duration_seconds.datapoints.length, 1, 'should have 1 datapoint')
    t.is(metrics.http_request_duration_seconds.datapoints[0].count, 3, 'should have 3 observations')
    t.is(
      metrics.http_request_duration_seconds.datapoints[0].sum,
      0.777,
      'should sum all observations'
    )
  })

  await t.test('should create separate histograms for different labels', function (t) {
    const registry = new MetricsRegistry()

    registry.recordHistogram('http_request_duration_seconds', 0.234, {
      method: 'GET',
      path: '/api/users'
    })

    registry.recordHistogram('http_request_duration_seconds', 0.102, {
      method: 'POST',
      path: '/api/jobs'
    })

    const metrics = registry.getAllMetrics()

    t.is(metrics.http_request_duration_seconds.datapoints.length, 2, 'should have 2 datapoints')
  })
})

test('MetricsRegistry - Gauge', async function (t) {
  await t.test('should set gauge value', function (t) {
    const registry = new MetricsRegistry()

    registry.setGauge('inference_model_agent_count', 5, {
      model: 'llama3'
    }, { help: 'Number of active inference agents' })

    const metrics = registry.getAllMetrics()

    t.ok(metrics.inference_model_agent_count, 'should have gauge metric')
    t.is(metrics.inference_model_agent_count.type, 'gauge', 'should be gauge type')
    t.is(metrics.inference_model_agent_count.datapoints.length, 1, 'should have 1 datapoint')
    t.is(metrics.inference_model_agent_count.datapoints[0].value, 5, 'should have value 5')
  })

  await t.test('should overwrite gauge with same labels', function (t) {
    const registry = new MetricsRegistry()

    registry.setGauge('inference_model_agent_count', 5, { model: 'llama3' })
    registry.setGauge('inference_model_agent_count', 8, { model: 'llama3' })

    const metrics = registry.getAllMetrics()

    t.is(metrics.inference_model_agent_count.datapoints.length, 1, 'should have 1 datapoint')
    t.is(metrics.inference_model_agent_count.datapoints[0].value, 8, 'should have updated value 8')
  })

  await t.test('should create separate gauges for different labels', function (t) {
    const registry = new MetricsRegistry()

    registry.setGauge('inference_model_agent_count', 5, { model: 'llama3' })
    registry.setGauge('inference_model_agent_count', 3, { model: 'mistral' })

    const metrics = registry.getAllMetrics()

    t.is(metrics.inference_model_agent_count.datapoints.length, 2, 'should have 2 datapoints')
  })
})

test('MetricsRegistry - Clear operations', async function (t) {
  await t.test('should clear only gauges with clearGauges', function (t) {
    const registry = new MetricsRegistry()

    registry.incrementCounter('http_requests_total', 5)
    registry.setGauge('active_connections', 10)
    registry.recordHistogram('request_duration', 0.5)

    registry.clearGauges()

    const metrics = registry.getAllMetrics()

    t.ok(metrics.http_requests_total, 'counter should remain')
    t.ok(metrics.request_duration, 'histogram should remain')
    t.absent(metrics.active_connections, 'gauge should be cleared')
  })

  await t.test('should clear all metrics with clear', function (t) {
    const registry = new MetricsRegistry()

    registry.incrementCounter('http_requests_total', 5)
    registry.setGauge('active_connections', 10)
    registry.recordHistogram('request_duration', 0.5)

    registry.clear()

    const metrics = registry.getAllMetrics()

    t.is(Object.keys(metrics).length, 0, 'all metrics should be cleared')
  })
})

test('MetricsRegistry - Multiple metric types', async function (t) {
  await t.test('should handle multiple metric types together', function (t) {
    const registry = new MetricsRegistry()

    registry.incrementCounter('http_requests_total', 1, {
      method: 'GET',
      path: '/api/users',
      status_code: '200'
    }, { help: 'Total HTTP requests' })

    registry.recordHistogram('http_request_duration_seconds', 0.234, {
      method: 'GET',
      path: '/api/users'
    }, { help: 'Request duration in seconds' })

    registry.setGauge('inference_model_agent_count', 5, {
      model: 'llama3'
    }, { help: 'Number of active inference agents' })

    const metrics = registry.getAllMetrics()

    t.is(Object.keys(metrics).length, 3, 'should have 3 different metrics')
    t.ok(metrics.http_requests_total, 'should have counter')
    t.ok(metrics.http_request_duration_seconds, 'should have histogram')
    t.ok(metrics.inference_model_agent_count, 'should have gauge')
  })
})
