# svc-facs-metrics

Metrics collection facility for svc services with Prometheus integration via Hyperswarm.

## Features

- **Automatic System Metrics**: CPU, memory, and process metrics collected by default
- **Custom Metrics**: Support for Gauges, Counters, and Histograms
- **Hyperswarm Transport**: Push metrics via Hyperswarm to tether-wrk-monitor
- **Prometheus Integration**: Metrics forwarded to Prometheus Push Gateway
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
  "collectSystemMetrics": true,
  "systemMetricsInterval": 10000,
  "flushInterval": 15000
}
```

**Note**: Use the same `topic` and `secretKey` as your logging configuration. The monitor differentiates logs from metrics based on message type (`pino.logs` vs `prom.metrics`).

### Configuration Options

- **enabled**: Enable/disable metrics collection
- **app**: Application identifier (used as `app` label in metrics)
- **topic**: Hyperswarm topic (use same as logging - typically `pino.logs`)
- **secretKey**: Authentication key (use same as logging secretKey)
- **collectSystemMetrics**: Auto-collect Node.js process and OS metrics
- **systemMetricsInterval**: Interval in ms for system metrics collection (default: 10000)
- **flushInterval**: Interval in ms to flush metrics (default: 15000)

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

When `collectSystemMetrics` is enabled, the following metrics are automatically collected:

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
Service → svc-facs-metrics → Hyperswarm → tether-wrk-monitor → Prometheus Push Gateway → Prometheus
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