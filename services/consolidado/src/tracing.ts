import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// Precisa ser o primeiro import do processo: as instrumentações trocam http, express e pg
// antes de eles serem carregados. Só liga quando há um coletor configurado.
let sdk: NodeSDK | null = null;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk = new NodeSDK({
    resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'consolidado' }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: req => ['/health', '/ready', '/metrics'].includes((req.url ?? '').split('?')[0]),
      }),
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
}

/** Envia o que estiver no buffer antes de o processo encerrar. */
export async function encerrarTracing(): Promise<void> {
  if (sdk) await sdk.shutdown().catch(() => undefined);
}
