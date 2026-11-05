import { SpanKind, trace } from '@opentelemetry/api';
import { emSpan, idsDoTraceAtivo, traceparentAtual } from '../../src/telemetria';
import { ligarOtelDeTeste } from '../helpers/otel';

const otel = ligarOtelDeTeste();
afterAll(async () => otel.desligar());
beforeEach(() => otel.spans.reset());

const tracer = () => trace.getTracer('teste');

describe('propagação de contexto', () => {
  it('sem span ativo não há traceparent nem ids de trace', () => {
    expect(traceparentAtual()).toBeNull();
    expect(idsDoTraceAtivo()).toEqual({});
  });

  it('um span que recebe traceparent continua o mesmo trace, como filho do span de origem', async () => {
    let origem = '';
    let traceIdOrigem = '';
    let spanIdOrigem = '';
    await emSpan('requisicao', { kind: SpanKind.SERVER }, async span => {
      origem = traceparentAtual() as string;
      traceIdOrigem = span.spanContext().traceId;
      spanIdOrigem = span.spanContext().spanId;
    });
    expect(origem).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // Tempo depois e fora do contexto original, como acontece no relay e no consumidor
    await emSpan('processar', { kind: SpanKind.CONSUMER, traceparent: origem }, async span => {
      expect(span.spanContext().traceId).toBe(traceIdOrigem);
      expect(idsDoTraceAtivo()).toMatchObject({ traceId: traceIdOrigem });
    });

    const filho = otel.spans.getFinishedSpans().find(s => s.name === 'processar');
    expect(filho?.parentSpanId).toBe(spanIdOrigem);
    expect(filho?.kind).toBe(SpanKind.CONSUMER);
  });

  it('registra a exceção e marca o span com erro', async () => {
    await expect(
      emSpan('falha', { kind: SpanKind.INTERNAL }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const span = otel.spans.getFinishedSpans().find(s => s.name === 'falha');
    expect(span?.status.code).toBe(2);
    expect(span?.events.some(e => e.name === 'exception')).toBe(true);
  });

  it('traceparent inválido não derruba: o span nasce como raiz', async () => {
    await emSpan('x', { kind: SpanKind.CONSUMER, traceparent: 'lixo' }, async span => {
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    });
    expect(tracer()).toBeDefined();
  });
});
