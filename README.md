# svc-facs-metrics

Metrics collection facility for svc services, forwarding metrics via Hyperswarm to tether-wrk-monitor.

## Features

- **Automatic System Metrics**: CPU, memory, and process metrics collected by default
- **Custom Metrics**: Support for Gauges, Counters, and Histograms
- **Hyperswarm Transport**: Push metrics via Hyperswarm to tether-wrk-monitor
- **Self-configuring**: Loads configuration from `config/facs/metrics.config.json`

## Installation

```bash
npm install git+https://github.com/tetherto/svc-facs-metrics.git
```

## Configuration

Create `config/facs/metrics.config.json` in your worker:

```json
{
  "enabled": true,
  "app": "your-worker-name",
  "topic": "pino.logs",
  "secretKey": "your-secret-key-here",
  "flushInterval": 15000,
  "maxSeries": 10000,
  "collectors": [
    {
      "collector": "@tetherto/svc-facs-metrics/lib/collectors/system-metrics-collector",
      "interval": 10000
    }
  ]
}
```

**Note**: Use the same `topic` and `secretKey` as your logging configuration. The monitor differentiates logs from metrics based on message type (`pino.logs` vs `prom.metrics`).

### Configuration Options

- **enabled**: Enable/disable metrics collection
- **app**: Application identifier (used as `app` label in metrics)
- **topic**: Hyperswarm topic (use same as logging - typically `pino.logs`)
- **secretKey**: Authentication key (use same as logging secretKey)
- **collectors**: Collectors to run and how often — see [Collectors](#collectors). Nothing is
  collected unless listed here
- **flushInterval**: Interval in ms to flush metrics (default: 15000)
- **maxSeries**: Optional cap on distinct series held in the registry (default: no cap). See
  [Memory and delivery behaviour](#memory-and-delivery-behaviour)

## Collectors

Anything sampled on an interval is a **collector**. A collector writes into the registry
itself and declares each metric's type, so adding one needs no change to this facility.

### Configuring collectors

```json
{
  "collectors": [
    {
      "collector": "@tetherto/svc-facs-metrics/lib/collectors/system-metrics-collector",
      "interval": 10000
    },
    {
      "collector": "./lib/collectors/queue-depth",
      "interval": 5000,
      "opts": { "name": "jobs" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `collector` | **Always a module reference, never a keyword** — a path beginning with `.` (resolved from the worker's working directory), an absolute path, or a resolvable module id. The facility keeps no catalogue of collectors, so it imports none of them, including its own |
| `interval` | Collection interval in ms (required, positive) |
| `opts` | Passed to the collector's constructor alongside the registry |
| `enabled` | Set `false` to keep an entry in config without running it |

References are resolved from the **worker's** working directory, so a module id works
regardless of whether the facility is a normal install, an `npm link`, or a `file:` dependency.

A collector that fails to resolve or throws during collection is logged and skipped — it cannot
stop the other collectors or take the worker down. Nothing is collected unless it is listed:
there is no implicit default.

### Writing a collector

```js
const { BaseCollector } = require('@tetherto/svc-facs-metrics')

class QueueDepthCollector extends BaseCollector {
  collect () {
    this.gauge('queue_depth', this.opts.queue.length, { queue: this.opts.name })
    this.counter('queue_processed_total', this.opts.queue.drainedSinceLastCollect())
  }
}

module.exports = QueueDepthCollector
```

`collect()` may be async. Use `gauge()`, `counter()` and `histogram()` to declare each
metric's type explicitly — nothing is inferred from the metric name. **`counter()` takes the
delta since the last collection, not a cumulative total**, because the registry adds what it is
given. An optional `close()` is awaited when the facility stops.

### Registering from code

Config can only name a module, so a collector needing a live dependency — a connection, a
fetch function, a service handle — is registered programmatically:

```js
this.metrics_m0.addCollector(MyCollector, {
  key: 'my-collector',
  interval: 15000,
  opts: { fetchText: () => this.proxy.scrape() }
})

this.metrics_m0.removeCollector('my-collector')
```

`addCollector` accepts a class (constructed with the registry plus `opts`) or a ready
instance, and works after the facility has started.

### Event-driven metrics

Collectors are for *sampling*. Metrics tied to events — a request completing, an error being
returned — are recorded directly, since there is nothing to poll:

```js
this.metrics_m0.recordCounter('http_requests_total', 1, { route, status })
this.metrics_m0.recordHistogram('http_request_duration_seconds', seconds, { route })
```

## Memory and delivery behaviour

Worth understanding before running this in production, particularly if the monitor can be
unreachable for long stretches.

**Nothing is buffered across an outage.** Every flush hands the registry's current contents to
the exporter and then clears the gauges, whether or not the send succeeded — if there is no
authenticated connection, `sendMetrics` returns early and those gauge values are simply
dropped. Memory therefore does **not** grow while disconnected.

That is the right trade-off for this data: a gauge only has a current value, so replaying a
backlog of stale samples has no value, and buffering across a long outage is how a monitoring
outage turns into an OOM.

**What each metric type does across a disconnect:**

| Type | Behaviour |
|---|---|
| Gauge | Dropped each flush; the next successful flush sends the newest value |
| Counter | Never cleared, so the accumulated total survives and the next successful flush reports it correctly — no lost increments |
| Histogram | Never cleared; fixed-size bucket array per series, so `sum`/`count`/buckets stay accurate |

**Memory is bounded by label cardinality, not by time or outage duration.** The registry holds
one entry per unique metric name + label set. Counters and histograms are never evicted, so a
label carrying unbounded values (a request id, a user id, a file path) grows the registry for
the lifetime of the process — the standard Prometheus-client cardinality rule applies here too.

Set **`maxSeries`** as a safety net: once the registry holds that many series, new ones are
dropped and a single warning is logged, while existing series keep updating. Leave it unset for
no cap.

**Recovery.** The exporter registers its connection handler once at `start()`; Hyperswarm
re-dials the topic peer by itself, so a dropped connection is re-adopted and re-authenticated
automatically. An errored socket is destroyed rather than left half-open.

## Usage

### Basic Setup

```javascript
// In your worker's init() method
this.setInitFacs([
  // ... other facs ...
  ['fac', 'svc-facs-metrics', 'm0', 'm0', {}]
])
```

### Recording Metrics

**Important**: `app` and `instance` labels are automatically added to all metrics based on your configuration. You only need to specify additional labels specific to each metric.

```javascript
// Gauge - current value
this.metrics_m0.recordGauge('active_connections', 42, {}, {
  help: 'Number of active connections'
})
// Result: active_connections{app="your-app",instance="12345"} 42

// Counter - incrementing value
this.metrics_m0.recordCounter('http_requests_total', 1, {
  method: 'GET',
  path: '/api/users',
  status: 200
}, {
  help: 'Total HTTP requests'
})
// Result: http_requests_total{app="your-app",instance="12345",method="GET",path="/api/users",status="200"} 1

// Histogram - observations (e.g., durations)
this.metrics_m0.recordHistogram('request_duration_seconds', 0.234, {
  method: 'POST',
  path: '/api/data'
}, {
  help: 'Request duration in seconds'
})
// Result: request_duration_seconds{app="your-app",instance="12345",method="POST",path="/api/data"} 0.234

// Timer - convenient way to measure duration
// Option 1: Auto-record with metric name
const endTimer = this.metrics_m0.startTimer('operation_duration_seconds', {
  operation: 'database_query'
})
// ... do work ...
endTimer() // Records the duration automatically

// Option 2: Just get the duration
const timer = this.metrics_m0.startTimer()
// ... do work ...
const duration = timer() // Returns duration, doesn't record automatically
this.metrics_m0.recordHistogram('custom_duration', duration, { type: 'custom' })
```

## System Metrics

When `lib/collectors/system-metrics-collector` is listed in `collectors`, the following are
collected:

### Memory Metrics
- `process_resident_memory_bytes` - Resident memory size
- `process_heap_total_bytes` - Total heap size
- `process_heap_used_bytes` - Used heap size
- `process_external_memory_bytes` - External memory
- `system_free_memory_bytes` - Free system memory
- `system_total_memory_bytes` - Total system memory
- `system_memory_usage_ratio` - Memory usage ratio (0-1)

### CPU Metrics
- `process_cpu_user_seconds_total` - User CPU time (counter)
- `process_cpu_system_seconds_total` - System CPU time (counter)
- `process_cpu_usage_percent` - Current CPU usage percentage
- `system_cpu_count` - Number of CPUs
- `system_load_average_1m/5m/15m` - System load averages

### Process Metrics
- `process_uptime_seconds` - Process uptime
- `process_pid` - Process ID

## Architecture

```
Service → svc-facs-metrics → Hyperswarm → tether-wrk-monitor
```

## Examples

### HTTP Server Metrics

```javascript
async handleRequest(req, res) {
  const endTimer = this.metrics_m0.startTimer('http_request_duration_seconds', {
    method: req.method,
    path: req.route?.path || req.path
  })
  
  try {
    // Handle request
    const result = await processRequest(req)
    
    this.metrics_m0.recordCounter('http_requests_total', 1, {
      method: req.method,
      path: req.route?.path || req.path,
      status: res.statusCode
    })
    
    endTimer()
    return result
  } catch (err) {
    this.metrics_m0.recordCounter('http_requests_total', 1, {
      method: req.method,
      path: req.route?.path || req.path,
      status: 500
    })
    endTimer()
    throw err
  }
}
```

### Custom Application Metrics

```javascript
// Track model agent counts in inference proxy
_recordInferenceMetrics() {
  const modelsCounts = this.inferenceService.getModelAgentCounts()
  
  for (const [model, count] of Object.entries(modelsCounts)) {
    this.metrics_m0.recordGauge('inference_active_model_agents', count, {
      model
    }, {
      help: 'Number of active inference agents per model'
    })
  }
}
```