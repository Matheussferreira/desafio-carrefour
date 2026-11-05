import { Channel } from 'amqplib';
import { config } from './config';
import { logger } from './logger';
import { ResilientBroker } from './broker/resilientBroker';
import { rabbitmqConnected } from './metrics';

export const EXCHANGE = 'lancamentos.events';
export const QUEUE = 'consolidado.lancamentos';
export const ROUTING_KEY = 'lancamento.registrado';
export const DLX = 'lancamentos.events.dlx';
export const DLQ = 'consolidado.lancamentos.dlq';

async function declararTopologia(canal: Channel): Promise<void> {
  await canal.assertExchange(DLX, 'topic', { durable: true });
  await canal.assertQueue(DLQ, { durable: true });
  await canal.bindQueue(DLQ, DLX, '#');

  await canal.assertExchange(EXCHANGE, 'topic', { durable: true });
  await canal.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX,
      'x-dead-letter-routing-key': ROUTING_KEY,
    },
  });
  await canal.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);

  // prefetch=1: uma mensagem por vez em cada consumidor (seguro para N réplicas)
  await canal.prefetch(1);
}

export function criarBroker(url = config.rabbitmqUrl): ResilientBroker<Channel> {
  const broker = new ResilientBroker<Channel>({
    url,
    logger,
    criarCanal: conexao => conexao.createChannel(),
    preparar: declararTopologia,
  });
  broker.on('connected', () => rabbitmqConnected.set(1));
  broker.on('disconnected', () => rabbitmqConnected.set(0));
  return broker;
}

/** Instância usada pelo serviço (conecta quando start() é chamado). */
export const broker = criarBroker();
