import { context, propagation, ROOT_CONTEXT, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

// Usa só a API do OpenTelemetry. Sem o SDK ligado (src/tracing.ts), tudo aqui vira no-op.

/** traceparent (W3C) do span ativo, ou null quando não há trace em andamento. */
export function traceparentAtual(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** Ids do trace ativo, para os logs. */
export function idsDoTraceAtivo(): { traceId: string; spanId: string } | Record<string, never> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}

interface OpcoesSpan {
  kind: SpanKind;
  /** Contexto de origem no formato W3C. Sem ele, o span nasce dentro do contexto atual. */
  traceparent?: string | null;
  atributos?: Record<string, string | number | boolean>;
}

/**
 * Executa fn dentro de um span. Quando vem um traceparent (por exemplo o gravado no outbox
 * ou o cabeçalho da mensagem), o span continua o trace de quem originou o evento.
 */
export async function emSpan<T>(
  nome: string,
  opcoes: OpcoesSpan,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const pai = opcoes.traceparent
    ? propagation.extract(ROOT_CONTEXT, { traceparent: opcoes.traceparent })
    : context.active();
  const span = trace.getTracer('caixa').startSpan(
    nome,
    { kind: opcoes.kind, attributes: opcoes.atributos },
    pai,
  );
  try {
    return await context.with(trace.setSpan(pai, span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
