import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

export const httpRequestsTotal = new Counter({
  name: 'consolidado_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'consolidado_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const eventsProcessedTotal = new Counter({
  name: 'consolidado_events_processed_total',
  help: 'Total events processed by the consumer',
  labelNames: ['tipo', 'status'], // status: processed | skipped | dlq | invalid
  registers: [register],
});

export const consumerRetriesTotal = new Counter({
  name: 'consolidado_consumer_retries_total',
  help: 'Total consumer retry attempts before success or DLQ',
  registers: [register],
});

export const consumerDlqTotal = new Counter({
  name: 'consolidado_consumer_dlq_total',
  help: 'Total messages sent to DLQ after exhausting retries',
  registers: [register],
});

export const rabbitmqConnected = new Gauge({
  name: 'consolidado_rabbitmq_connected',
  help: '1 quando a conexão do consumidor com o RabbitMQ está de pé, 0 caso contrário',
  registers: [register],
});

export const eventoLagSegundos = new Histogram({
  name: 'consolidado_evento_lag_seconds',
  help: 'Tempo entre a criação do evento (createdAt) e a aplicação ao saldo, em segundos',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
  registers: [register],
});
