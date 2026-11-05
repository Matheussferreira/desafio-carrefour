import type { Channel, ConsumeMessage } from 'amqplib';
import { QUEUE } from '../rabbitmq';
import type { ResilientBroker } from '../broker/resilientBroker';
import { pool } from '../db';
import { gravarAtualizadoAte, invalidarAPartirDe } from '../cache/saldoCache';
import { logger } from '../logger';
import {
  eventsProcessedTotal,
  consumerRetriesTotal,
  consumerDlqTotal,
} from '../metrics';
import { withRetry } from '../utils/retry';
import { calcularDelta, EventoLancamentoRegistrado, interpretarMensagem } from '../domain/evento';

const MAX_RETRIES = 3;
// Backoff exponencial: 1s → 2s → 4s
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/**
 * Aplica o evento ao saldo diário. Idempotente: o mesmo eventoId nunca altera o saldo duas vezes.
 */
export async function processEvent(
  evento: EventoLancamentoRegistrado,
): Promise<'processed' | 'skipped'> {
  const { eventoId, correlationId, comercianteId, data: payload } = evento;
  const log = logger.child({ eventoId, correlationId, comercianteId, lancamentoId: payload.lancamentoId });
  const delta = calcularDelta(payload.tipo, payload.valor);
  let atualizadoAte = '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotência: tenta inserir o evento; rowCount=0 significa já processado
    const idemp = await client.query(
      `INSERT INTO eventos_processados (evento_id) VALUES ($1)
       ON CONFLICT (evento_id) DO NOTHING`,
      [eventoId],
    );

    if (idemp.rowCount === 0) {
      await client.query('ROLLBACK');
      log.info('Event already processed, skipping');
      return 'skipped';
    }

    // Upsert atômico: o banco soma, a aplicação nunca lê e reescreve o saldo
    await client.query(
      `INSERT INTO saldo_diario (comerciante_id, data, total_creditos, total_debitos, saldo, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (comerciante_id, data) DO UPDATE SET
         total_creditos = saldo_diario.total_creditos + $3,
         total_debitos  = saldo_diario.total_debitos  + $4,
         saldo          = saldo_diario.saldo          + $5,
         updated_at     = now()`,
      [comercianteId, payload.data, delta.creditos, delta.debitos, delta.saldo],
    );

    // Até onde este comerciante está atualizado: o maior instante de lançamento já aplicado
    const { rows } = await client.query<{ ultimo_evento_em: Date }>(
      `INSERT INTO comerciante_progresso (comerciante_id, ultimo_evento_em)
       VALUES ($1, $2)
       ON CONFLICT (comerciante_id) DO UPDATE SET
         ultimo_evento_em = GREATEST(comerciante_progresso.ultimo_evento_em, EXCLUDED.ultimo_evento_em),
         processado_em    = now()
       RETURNING ultimo_evento_em`,
      [comercianteId, evento.createdAt ?? new Date().toISOString()],
    );
    atualizadoAte = rows[0].ultimo_evento_em.toISOString();

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Depois do commit: invalida a data e as posteriores do comerciante (o acumulado delas muda)
  // e publica o atualizadoAte. Falha no Redis não desfaz o processamento.
  try {
    const apagadas = await invalidarAPartirDe(comercianteId, payload.data);
    await gravarAtualizadoAte(comercianteId, atualizadoAte);
    log.debug({ apagadas }, 'Cache invalidado');
  } catch (cacheErr) {
    log.warn({ cacheErr }, 'Failed to invalidate cache (non-fatal)');
  }

  log.info({ comercianteId, data: payload.data, tipo: payload.tipo, valor: payload.valor }, 'Event processed');
  return 'processed';
}

// Confirmação pode falhar se o canal caiu no meio do processamento. Sem problema:
// o broker reentrega e a idempotência descarta a repetição.
function seguro(acao: () => void): void {
  try {
    acao();
  } catch (err) {
    logger.warn({ err }, 'Canal indisponível ao confirmar mensagem, o broker vai reentregar');
  }
}

let consumerTag: string | null = null;
let canalAtivo: Channel | null = null;
let inFlight = 0;
let shuttingDown = false;

async function tratar(ch: Channel, msg: ConsumeMessage): Promise<void> {
  // Durante shutdown: devolve a mensagem para a fila
  if (shuttingDown) {
    seguro(() => ch.nack(msg, false, true));
    return;
  }

  inFlight++;
  try {
    const interpretada = interpretarMensagem(msg.content.toString());

    if (interpretada.tipo === 'invalido') {
      logger.error({ motivo: interpretada.motivo }, 'Invalid event, sending to DLQ');
      eventsProcessedTotal.inc({ tipo: 'unknown', status: 'invalid' });
      consumerDlqTotal.inc();
      seguro(() => ch.nack(msg, false, false));
      return;
    }

    if (interpretada.tipo === 'ignorado') {
      logger.warn({ tipo: interpretada.tipoEvento }, 'Unknown event type, acknowledging');
      eventsProcessedTotal.inc({ tipo: interpretada.tipoEvento, status: 'invalid' });
      seguro(() => ch.ack(msg));
      return;
    }

    const { evento } = interpretada;
    const log = logger.child({ eventoId: evento.eventoId, correlationId: evento.correlationId });

    const result = await withRetry(
      () => processEvent(evento),
      MAX_RETRIES,
      RETRY_DELAYS_MS,
      (err, attempt) => {
        consumerRetriesTotal.inc();
        log.warn({ err, attempt, maxRetries: MAX_RETRIES }, 'Processing failed, retrying with backoff');
      },
    );

    if (result.ok) {
      eventsProcessedTotal.inc({ tipo: 'LancamentoRegistrado', status: result.value });
      seguro(() => ch.ack(msg));
    } else {
      log.error({ error: result.error }, 'Max retries exceeded, sending to DLQ');
      eventsProcessedTotal.inc({ tipo: 'LancamentoRegistrado', status: 'dlq' });
      consumerDlqTotal.inc();
      seguro(() => ch.nack(msg, false, false));
    }
  } finally {
    inFlight--;
  }
}

/** Registra o consumidor no canal atual (chamado a cada conexão). */
export async function startConsumer(ch: Channel): Promise<void> {
  const { consumerTag: tag } = await ch.consume(QUEUE, msg => {
    if (msg) void tratar(ch, msg);
  });
  consumerTag = tag;
  canalAtivo = ch;
  logger.info({ queue: QUEUE }, 'Consumer started');
}

export function consumerAtivo(): boolean {
  return consumerTag !== null;
}

/**
 * Liga o consumidor ao broker: registra a cada (re)conexão e marca como inativo quando a conexão cai.
 */
export function iniciarConsumidor(broker: ResilientBroker<Channel>): void {
  broker.on('connected', (ch: Channel) => {
    startConsumer(ch).catch(err => {
      logger.error({ err }, 'Falha ao registrar o consumidor, reiniciando o canal');
      ch.close().catch(() => undefined);
    });
  });
  broker.on('disconnected', () => {
    consumerTag = null;
    canalAtivo = null;
  });
}

export async function stopConsumer(): Promise<void> {
  shuttingDown = true;

  if (consumerTag && canalAtivo) {
    try {
      await canalAtivo.cancel(consumerTag);
      logger.info({ consumerTag }, 'Consumer cancelled');
    } catch {
      // Canal pode já estar fechando
    }
  }
  consumerTag = null;
  canalAtivo = null;

  // Aguarda a mensagem em processamento terminar (máx. 8s)
  const deadline = Date.now() + 8_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 100));
  }

  if (inFlight > 0) {
    logger.warn({ inFlight }, 'Graceful shutdown deadline reached with in-flight messages');
  }
}
