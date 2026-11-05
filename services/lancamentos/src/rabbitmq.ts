import { ConfirmChannel } from 'amqplib';
import { config } from './config';
import { logger } from './logger';
import { ResilientBroker } from './broker/resilientBroker';
import { rabbitmqConnected } from './metrics';

export const EXCHANGE = 'lancamentos.events';
export const ROUTING_KEY = 'lancamento.registrado';
export const CONSUMER_QUEUE = 'consolidado.lancamentos';
export const DLX = 'lancamentos.events.dlx';
export const DLQ = 'consolidado.lancamentos.dlq';

/**
 * Declara a topologia. O relay também declara a fila do consolidado para que
 * eventos publicados antes de o consolidado subir não sejam descartados.
 */
export async function declararTopologia(canal: ConfirmChannel): Promise<void> {
  await canal.assertExchange(DLX, 'topic', { durable: true });
  await canal.assertQueue(DLQ, { durable: true });
  await canal.bindQueue(DLQ, DLX, '#');
  await canal.assertExchange(EXCHANGE, 'topic', { durable: true });
  await canal.assertQueue(CONSUMER_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX,
      'x-dead-letter-routing-key': ROUTING_KEY,
    },
  });
  await canal.bindQueue(CONSUMER_QUEUE, EXCHANGE, ROUTING_KEY);
}

export function criarBroker(url = config.rabbitmqUrl): ResilientBroker<ConfirmChannel> {
  const broker = new ResilientBroker<ConfirmChannel>({
    url,
    logger,
    criarCanal: conexao => conexao.createConfirmChannel(),
    preparar: declararTopologia,
  });
  broker.on('connected', () => rabbitmqConnected.set(1));
  broker.on('disconnected', () => rabbitmqConnected.set(0));
  return broker;
}
