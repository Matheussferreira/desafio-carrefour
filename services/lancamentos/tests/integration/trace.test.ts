/**
 * O contexto de trace atravessa o outbox: gravado na requisição, usado pelo relay (que roda
 * depois, fora da requisição) e enviado no cabeçalho traceparent da mensagem.
 */
import { SpanKind } from '@opentelemetry/api';
import { pool } from '../../src/db';
import { registrarLancamento } from '../../src/domain/lancamentoService';
import { runMigrations } from '../../src/migrations';
import { CanalPublicador, relayTick } from '../../src/relay/outboxRelay';
import { emSpan } from '../../src/telemetria';
import { ligarOtelDeTeste } from '../helpers/otel';

const otel = ligarOtelDeTeste();

beforeAll(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE outbox, lancamentos');
  otel.spans.reset();
});

afterAll(async () => {
  await otel.desligar();
  await pool.end();
});

describe('propagação de trace pelo outbox', () => {
  it('a mensagem publicada leva o traceparent da requisição que criou o lançamento', async () => {
    let traceIdRequisicao = '';
    await emSpan('POST /lancamentos', { kind: SpanKind.SERVER }, async span => {
      traceIdRequisicao = span.spanContext().traceId;
      await registrarLancamento(
        pool,
        'loja-1',
        { valor: '10.00', tipo: 'credito', data: '2035-01-01' },
        { correlationId: 'c-1', idempotencyKey: 'trace-1' },
      );
    });

    const { rows } = await pool.query('SELECT traceparent FROM outbox');
    expect(rows[0].traceparent).toContain(traceIdRequisicao);

    // O relay roda depois, fora de qualquer span
    const publicados: Array<{ headers?: Record<string, string> }> = [];
    const canal: CanalPublicador = {
      publish: (_e, _k, _c, opts, cb) => {
        publicados.push({ headers: opts.headers as Record<string, string> | undefined });
        setImmediate(() => cb(null));
        return true;
      },
    };
    await relayTick({ pool, canal });

    expect(publicados).toHaveLength(1);
    const tp = publicados[0].headers?.traceparent ?? '';
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(tp.split('-')[1]).toBe(traceIdRequisicao);

    const spanRelay = otel.spans.getFinishedSpans().find(s => s.name === 'outbox publicar');
    expect(spanRelay?.spanContext().traceId).toBe(traceIdRequisicao);
    expect(spanRelay?.kind).toBe(SpanKind.PRODUCER);
  });

  it('evento antigo, sem traceparent gravado, é publicado normalmente e o relay inicia um trace novo', async () => {
    await pool.query(
      `INSERT INTO outbox (id, tipo_evento, payload) VALUES (gen_random_uuid(), 'LancamentoRegistrado', '{}')`,
    );
    const headers: Array<Record<string, string> | undefined> = [];
    const canal: CanalPublicador = {
      publish: (_e, _k, _c, opts, cb) => {
        headers.push(opts.headers as Record<string, string> | undefined);
        setImmediate(() => cb(null));
        return true;
      },
    };
    await relayTick({ pool, canal });
    expect(headers).toHaveLength(1);
    expect(headers[0]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });
});
