import { NodeSDK } from '@opentelemetry/sdk-node';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// Precisa ser o primeiro import do processo: as instrumentações trocam http, express e pg
// antes de eles serem carregados. Só liga quando há um coletor configurado.
let sdk: NodeSDK | null = null;

// Quais instrumentações ligar (lista separada por vírgula). O padrão é http,express,pg.
// Cada uma acrescenta spans por requisição e, portanto, CPU: ver docs/observabilidade.md.
function instrumentacoes(): Instrumentation[] {
  const ligadas = (process.env.OTEL_INSTRUMENTACOES ?? 'http,express,pg').split(',').map(s => s.trim());
  const lista: Instrumentation[] = [];
  if (ligadas.includes('http')) {
    lista.push(
      new HttpInstrumentation({
        ignoreIncomingRequestHook: req => ['/health', '/ready', '/metrics'].includes((req.url ?? '').split('?')[0]),
      }),
    );
  }
  if (ligadas.includes('express')) {
    lista.push(new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }));
  }
  if (ligadas.includes('pg')) lista.push(new PgInstrumentation());
  return lista;
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk = new NodeSDK({
    resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'lancamentos' }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: instrumentacoes(),
  });
  sdk.start();
}

/** Envia o que estiver no buffer antes de o processo encerrar. */
export async function encerrarTracing(): Promise<void> {
  if (sdk) await sdk.shutdown().catch(() => undefined);
}
