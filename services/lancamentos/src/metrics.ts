import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';

export const register = new Registry();
collectDefaultMetrics({ register });

export const httpRequestsTotal = new Counter({
  name: 'lancamentos_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'lancamentos_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const lancamentosCreatedTotal = new Counter({
  name: 'lancamentos_created_total',
  help: 'Total lancamentos criados com sucesso',
  labelNames: ['tipo'],
  registers: [register],
});

export const outboxEventsPublishedTotal = new Counter({
  name: 'lancamentos_outbox_events_published_total',
  help: 'Total de eventos publicados e confirmados pelo broker',
  registers: [register],
});

export const outboxPublishFailuresTotal = new Counter({
  name: 'lancamentos_outbox_publish_failures_total',
  help: 'Lotes do outbox que falharam na publicação (sem confirmação, sem rota ou erro de conexão)',
  registers: [register],
});

export const rabbitmqConnected = new Gauge({
  name: 'lancamentos_rabbitmq_connected',
  help: '1 quando a conexão do relay com o RabbitMQ está de pé, 0 caso contrário',
  registers: [register],
});

/**
 * Gauges do estado do outbox, calculados a cada scrape. Só o processo do relay os registra,
 * para a API não consultar o banco por conta do Prometheus.
 */
export function registrarGaugesOutbox(
  consultar: () => Promise<{ pendentes: number; idadeMaisAntigaSegundos: number }>,
): void {
  new Gauge({
    name: 'lancamentos_outbox_pendentes',
    help: 'Eventos no outbox ainda não publicados e confirmados pelo broker',
    registers: [register],
    async collect() {
      this.set((await consultar()).pendentes);
    },
  });
  new Gauge({
    name: 'lancamentos_outbox_idade_mais_antigo_segundos',
    help: 'Idade do evento pendente mais antigo do outbox (0 quando não há pendentes)',
    registers: [register],
    async collect() {
      this.set((await consultar()).idadeMaisAntigaSegundos);
    },
  });
}
