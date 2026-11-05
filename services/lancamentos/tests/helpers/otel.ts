import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Liga um tracer em memória e o propagador W3C, como o SDK faria em produção. */
export function ligarOtelDeTeste(): { spans: InMemorySpanExporter; desligar: () => Promise<void> } {
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(spans));
  const contexto = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contexto);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return {
    spans,
    desligar: async () => {
      await provider.shutdown();
      contexto.disable();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
