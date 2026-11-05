import { SpanKind } from '@opentelemetry/api';
import type { Channel, ConsumeMessage } from 'amqplib';
import { QUEUE } from '../rabbitmq';
import type { ResilientBroker } from '../broker/resilientBroker';
import { pool } from '../db';
import { avancarVersao, gravarUltimoEventoAplicadoEm } from '../cache/saldoCache';
import { logger } from '../logger';
import { emSpan } from '../telemetria';
import {
  eventsProcessedTotal,
  consumerRetriesTotal,
  consumerDlqTotal,
  consumerTransientTotal,
  eventoLagSegundos,
} from '../metrics';
import { withRetry } from '../utils/retry';
import { erroTransitorio } from '../utils/erroTransitorio';
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
  let ultimoEventoAplicadoEm = '';

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
    ultimoEventoAplicadoEm = rows[0].ultimo_evento_em.toISOString();

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Depois do commit: avança a versão do cache do comerciante (todas as datas dele passam a
  // ser lidas do banco, o que cobre o lançamento retroativo) e publica o ultimoEventoAplicadoEm.
  // A ordem importa: commit primeiro, versão por último (quem vê a versão nova já vê o resto). Falha no Redis não desfaz o processamento.
  try {
    await gravarUltimoEventoAplicadoEm(comercianteId, ultimoEventoAplicadoEm);
    const versao = await avancarVersao(comercianteId);
    log.debug({ versao }, 'Versão do cache avançada');
  } catch (cacheErr) {
    log.warn({ cacheErr }, 'Failed to invalidate cache (non-fatal)');
  }

  log.info({ comercianteId, data: payload.data, tipo: payload.tipo, valor: payload.valor }, 'Event processed');
  return 'processed';
}

// Espera entre tentativas enquanto o banco está fora: 1 s, 2 s, 4 s, 8 s e depois 15 s.
const ESPERA_TRANSITORIA_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** Dorme em fatias curtas para o desligamento do processo não ficar preso numa espera longa. */
async function dormirAteDesligar(ms: number): Promise<void> {
  const fim = Date.now() + ms;
  while (!shuttingDown && Date.now() < fim) {
    await new Promise<void>(r => setTimeout(r, Math.min(100, fim - Date.now())));
  }
}

/**
 * Aplica o evento e, se o banco estiver fora ou a conexão cair, mantém a mensagem retida (sem ack e
 * sem nack) e tenta de novo com espera crescente até o banco voltar. Com prefetch 1 isso pausa o
 * consumo, e o evento, que é válido, nunca vai para a DLQ por causa de uma falha de infraestrutura.
 * Erro que não é transitório é relançado para o withRetry e, esgotado, vai para a DLQ.
 * Retorna 'interrompido' se o processo começou a desligar durante a espera.
 */
async function aplicarEsperandoBanco(
  evento: EventoLancamentoRegistrado,
  log: typeof logger,
): Promise<'processed' | 'skipped' | 'interrompido'> {
  let tentativa = 0;
  for (;;) {
    try {
      return await processEvent(evento);
    } catch (err) {
      if (!erroTransitorio(err)) throw err;
      if (shuttingDown) return 'interrompido';
      consumerTransientTotal.inc();
      const esperaMs = ESPERA_TRANSITORIA_MS[Math.min(tentativa, ESPERA_TRANSITORIA_MS.length - 1)];
      tentativa++;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), tentativa, esperaMs },
        'Banco indisponível, mensagem retida até ele voltar',
      );
      await dormirAteDesligar(esperaMs);
      if (shuttingDown) return 'interrompido';
    }
  }
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

/** Trata uma mensagem dentro de um span que continua o trace de quem publicou (cabeçalho traceparent). */
function tratar(ch: Channel, msg: ConsumeMessage): Promise<void> {
  const traceparent = msg.properties.headers?.traceparent as string | undefined;
  return emSpan(
    'consolidado.lancamentos processar',
    { kind: SpanKind.CONSUMER, traceparent, atributos: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': QUEUE } },
    () => tratarMensagem(ch, msg),
  );
}

async function tratarMensagem(ch: Channel, msg: ConsumeMessage): Promise<void> {
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
      () => aplicarEsperandoBanco(evento, log),
      MAX_RETRIES,
      RETRY_DELAYS_MS,
      (err, attempt) => {
        consumerRetriesTotal.inc();
        log.warn({ err, attempt, maxRetries: MAX_RETRIES }, 'Processing failed, retrying with backoff');
      },
    );

    if (result.ok && result.value === 'interrompido') {
      // O processo está desligando: devolve a mensagem para a fila, sem contar como falha
      seguro(() => ch.nack(msg, false, true));
    } else if (result.ok) {
      eventsProcessedTotal.inc({ tipo: 'LancamentoRegistrado', status: result.value });
      if (result.value === 'processed' && evento.createdAt) {
        eventoLagSegundos.observe(Math.max(0, (Date.now() - Date.parse(evento.createdAt)) / 1000));
      }
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
