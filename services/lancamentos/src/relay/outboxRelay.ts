import { SpanKind } from '@opentelemetry/api';
import type { Options } from 'amqplib';
import { Pool } from 'pg';
import { EXCHANGE, ROUTING_KEY } from '../rabbitmq';
import { logger } from '../logger';
import { emSpan, traceparentAtual } from '../telemetria';
import { outboxEventsPublishedTotal, outboxPublishFailuresTotal } from '../metrics';

/** O que o relay precisa do canal: publicar com callback de confirmação (ConfirmChannel). */
export interface CanalPublicador {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    callback: (err: unknown) => void,
  ): boolean;
}

export interface RelayDeps {
  pool: Pool;
  canal: CanalPublicador;
  /** Ids de mensagens devolvidas pelo broker por falta de rota (evento "return" do canal). */
  devolvidas?: Set<string>;
  tamanhoLote?: number;
}

interface LinhaOutbox {
  id: string;
  tipo_evento: string;
  payload: object;
  traceparent: string | null;
}

/**
 * Um ciclo do relay. Seleciona um lote com FOR UPDATE SKIP LOCKED, publica e só marca
 * como publicado depois que o broker confirmou todas as mensagens. Se algo falhar, a
 * transação é desfeita e as linhas continuam pendentes. Várias instâncias podem rodar
 * em paralelo: cada uma pega linhas diferentes.
 * Devolve quantos eventos foram publicados.
 */
export async function relayTick(deps: RelayDeps): Promise<number> {
  const limite = deps.tamanhoLote ?? 50;
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<LinhaOutbox>(
      `SELECT id, tipo_evento, payload, traceparent
       FROM outbox
       WHERE status = 'pendente'
       ORDER BY created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limite],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const resultados = await Promise.allSettled(
      rows.map(row =>
        // O span continua o trace da requisição que gravou o evento e cobre a confirmação do broker
        emSpan(
          'outbox publicar',
          {
            kind: SpanKind.PRODUCER,
            traceparent: row.traceparent,
            atributos: {
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': EXCHANGE,
              'messaging.message.id': row.id,
            },
          },
          () =>
            new Promise<void>((resolve, reject) => {
              const tp = traceparentAtual();
              deps.canal.publish(
                EXCHANGE,
                ROUTING_KEY,
                Buffer.from(JSON.stringify(row.payload)),
                {
                  persistent: true,
                  mandatory: true,
                  messageId: row.id,
                  contentType: 'application/json',
                  ...(tp ? { headers: { traceparent: tp } } : {}),
                },
                err => (err ? reject(err) : resolve()),
              );
            }),
        ),
      ),
    );

    const falha = resultados.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (falha) throw falha.reason instanceof Error ? falha.reason : new Error(String(falha.reason));

    const semRota = rows.filter(r => deps.devolvidas?.delete(r.id));
    if (semRota.length > 0) {
      throw new Error(`Broker devolveu ${semRota.length} mensagem(ns) sem rota (fila ou binding ausente)`);
    }

    await client.query(
      `UPDATE outbox SET status = 'publicado', published_at = now() WHERE id = ANY($1::uuid[])`,
      [rows.map(r => r.id)],
    );
    await client.query('COMMIT');
    outboxEventsPublishedTotal.inc(rows.length);
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface LoopRelay {
  parar(): Promise<void>;
}

/** Repete o ciclo: sem pausa enquanto houver lote cheio, com pausa quando a fila esvazia ou há erro. */
export function iniciarLoopRelay(opts: {
  ciclo: () => Promise<number>;
  intervaloMs: number;
  tamanhoLote: number;
}): LoopRelay {
  let parado = false;
  let timer: NodeJS.Timeout | null = null;
  let emExecucao: Promise<void> = Promise.resolve();

  const executar = async (): Promise<void> => {
    let publicados = 0;
    try {
      publicados = await opts.ciclo();
    } catch (err) {
      outboxPublishFailuresTotal.inc();
      logger.error({ err }, 'Falha no ciclo do outbox relay, o lote será tentado de novo');
    }
    if (parado) return;
    const espera = publicados >= opts.tamanhoLote ? 0 : opts.intervaloMs;
    timer = setTimeout(() => {
      emExecucao = executar();
    }, espera);
  };

  emExecucao = executar();

  return {
    async parar() {
      parado = true;
      if (timer) clearTimeout(timer);
      await emExecucao;
    },
  };
}
