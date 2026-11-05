import amqp, { Channel, ChannelModel } from 'amqplib';
import { pool } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { connectRedis, closeRedis } from '../../src/redis';
import { broker, EXCHANGE, ROUTING_KEY } from '../../src/rabbitmq';
import { consumerAtivo, iniciarConsumidor, stopConsumer } from '../../src/consumer/lancamentosConsumer';

export async function aguardar(condicao: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const limite = Date.now() + ms;
  while (!(await condicao())) {
    if (Date.now() > limite) throw new Error('Tempo esgotado aguardando condição');
    await new Promise(r => setTimeout(r, 100));
  }
}

export interface Infra {
  pubConn: ChannelModel;
  pubCh: Channel;
}

/** Sobe o mesmo caminho de produção: migrations, Redis, consumidor ligado ao broker resiliente. */
export async function iniciarInfra(): Promise<Infra> {
  await runMigrations(pool);
  await pool.query('TRUNCATE saldo_diario, eventos_processados, comerciante_progresso');
  await connectRedis();
  iniciarConsumidor(broker);
  broker.start();
  await aguardar(() => consumerAtivo());

  const pubConn = await amqp.connect(process.env.RABBITMQ_URL as string);
  const pubCh = await pubConn.createChannel();
  return { pubConn, pubCh };
}

export async function encerrarInfra(infra: Infra): Promise<void> {
  await stopConsumer();
  await infra.pubCh.close().catch(() => undefined);
  await infra.pubConn.close().catch(() => undefined);
  await broker.close();
  await closeRedis();
  await pool.end();
}

export function publicarEvento(ch: Channel, evento: { eventoId: string }): void {
  ch.publish(EXCHANGE, ROUTING_KEY, Buffer.from(JSON.stringify(evento)), {
    persistent: true,
    messageId: evento.eventoId,
  });
}

export interface OpcoesEvento {
  /** Padrão 'padrao'. Com null monta um evento 1.0 antigo, sem comercianteId. */
  comercianteId?: string | null;
  createdAt?: string;
}

export function montarEvento(
  eventoId: string,
  data: string,
  valor: string,
  tipo: 'credito' | 'debito' = 'credito',
  opcoes: OpcoesEvento = {},
) {
  const comercianteId = opcoes.comercianteId === undefined ? 'padrao' : opcoes.comercianteId;
  return {
    eventoId,
    schemaVersion: comercianteId === null ? '1.0' : '1.1',
    tipo: 'LancamentoRegistrado',
    ...(comercianteId === null ? {} : { comercianteId }),
    correlationId: `it-${eventoId.slice(0, 8)}`,
    createdAt: opcoes.createdAt ?? new Date().toISOString(),
    data: {
      lancamentoId: eventoId.replace(/^./, 'f'),
      valor,
      tipo,
      descricao: null,
      data,
    },
  };
}

/** Lê o valor atual de um Counter sem labels. */
export async function valorContador(counter: {
  get(): Promise<{ values: Array<{ value: number }> }>;
}): Promise<number> {
  const { values } = await counter.get();
  return values.reduce((soma, v) => soma + v.value, 0);
}
