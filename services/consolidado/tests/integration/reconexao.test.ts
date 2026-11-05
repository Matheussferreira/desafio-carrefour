/**
 * Reconexão ao RabbitMQ: derruba as conexões no broker de verdade e confere que
 * /ready fica vermelho, o consumidor volta sozinho e nenhuma mensagem se perde.
 */
import { execFileSync } from 'child_process';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { pool } from '../../src/db';
import { broker } from '../../src/rabbitmq';
import { consumerAtivo } from '../../src/consumer/lancamentosConsumer';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEvento } from './helpers';

const CONTAINER = process.env.RABBITMQ_IT_CONTAINER ?? 'desafio-as-it-rabbitmq-it-1';

describe('Reconexão ao RabbitMQ', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await iniciarInfra();
  }, 40_000);

  afterAll(async () => {
    await encerrarInfra(infra);
  });

  it('cai a conexão, /ready fica 503, volta sozinho e processa o que chegou depois', async () => {
    expect((await request(app).get('/ready')).status).toBe(200);

    execFileSync('docker', ['exec', CONTAINER, 'rabbitmqctl', 'close_all_connections', 'teste de reconexao']);

    await aguardar(() => !broker.isConnected(), 5_000);
    expect((await request(app).get('/ready')).status).toBe(503);

    await aguardar(() => broker.isConnected() && consumerAtivo(), 30_000);
    expect((await request(app).get('/ready')).status).toBe(200);

    // A conexão de publicação do teste também caiu; abre outra e publica
    const amqp = await import('amqplib');
    const conn = await amqp.connect(process.env.RABBITMQ_URL as string);
    const ch = await conn.createChannel();
    const evento = montarEvento(uuidv4(), '2032-01-01', '77.00');
    publicarEvento(ch, evento);
    await aguardar(async () => {
      const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [evento.eventoId]);
      return rows.length === 1;
    }, 10_000);
    await ch.close();
    await conn.close();

    const { rows } = await pool.query('SELECT saldo FROM saldo_diario WHERE data = $1', ['2032-01-01']);
    expect(rows[0].saldo).toBe('77.00');
  }, 60_000);
});
