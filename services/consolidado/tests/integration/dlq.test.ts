/**
 * Retry com backoff e Dead Letter Queue contra um RabbitMQ e um Postgres reais.
 * Pré-requisito: docker-compose.integration.yml no ar (use test-integration.ps1 ou .sh).
 */
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../../src/db';
import { DLQ } from '../../src/rabbitmq';
import { consumerDlqTotal, consumerRetriesTotal } from '../../src/metrics';
import {
  aguardar,
  encerrarInfra,
  iniciarInfra,
  Infra,
  montarEvento,
  publicarEvento,
  valorContador,
} from './helpers';

describe('Retry com backoff e Dead Letter Queue', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await iniciarInfra();
    await infra.pubCh.purgeQueue(DLQ);
  }, 40_000);

  afterAll(async () => {
    await encerrarInfra(infra);
  });

  it('banco indisponível: tenta 3 vezes com backoff e manda a mensagem intacta para a DLQ', async () => {
    const baseRetries = await valorContador(consumerRetriesTotal);
    const baseDlq = await valorContador(consumerDlqTotal);

    // Simula uma queda do banco: toda tentativa de obter conexão falha
    const spy = jest.spyOn(pool, 'connect').mockRejectedValue(new Error('banco indisponível (simulado)') as never);
    const eventoId = uuidv4();
    try {
      publicarEvento(infra.pubCh, montarEvento(eventoId, '2024-06-15', '10.00'));
      // backoff 1s + 2s + 4s = 7s
      await aguardar(async () => (await valorContador(consumerDlqTotal)) - baseDlq === 1, 15_000);
    } finally {
      spy.mockRestore();
    }

    expect((await valorContador(consumerRetriesTotal)) - baseRetries).toBe(3);

    await aguardar(async () => (await infra.pubCh.checkQueue(DLQ)).messageCount === 1, 5_000);
    const dlqMsg = await infra.pubCh.get(DLQ, { noAck: false });
    expect(dlqMsg).not.toBe(false);
    if (dlqMsg !== false) {
      expect(JSON.parse(dlqMsg.content.toString()).eventoId).toBe(eventoId);
      infra.pubCh.ack(dlqMsg);
    }

    const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [eventoId]);
    expect(rows).toHaveLength(0);
  }, 30_000);

  it('evento válido processa sem passar pela DLQ e atualiza o saldo', async () => {
    const baseDlq = await valorContador(consumerDlqTotal);
    const eventoId = uuidv4();

    publicarEvento(infra.pubCh, montarEvento(eventoId, '2024-06-15', '375.50'));
    await aguardar(async () => {
      const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [eventoId]);
      return rows.length === 1;
    }, 10_000);

    expect((await valorContador(consumerDlqTotal)) - baseDlq).toBe(0);
    expect((await infra.pubCh.checkQueue(DLQ)).messageCount).toBe(0);

    const { rows } = await pool.query<{ saldo: string; data: string }>(
      'SELECT data, saldo FROM saldo_diario WHERE data = $1',
      ['2024-06-15'],
    );
    expect(rows).toEqual([{ data: '2024-06-15', saldo: '375.50' }]);
  }, 20_000);

  it('evento malformado vai direto para a DLQ, sem retries e sem alterar saldo', async () => {
    const baseRetries = await valorContador(consumerRetriesTotal);
    const eventoId = uuidv4();
    // data em formato de timestamp viola o contrato do evento
    publicarEvento(infra.pubCh, montarEvento(eventoId, '2024-06-16T03:00:00.000Z', '10.00'));

    await aguardar(async () => (await infra.pubCh.checkQueue(DLQ)).messageCount === 1, 10_000);

    expect((await valorContador(consumerRetriesTotal)) - baseRetries).toBe(0);
    const { rows } = await pool.query("SELECT 1 FROM saldo_diario WHERE data = '2024-06-16'");
    expect(rows).toHaveLength(0);

    const msg = await infra.pubCh.get(DLQ, { noAck: false });
    if (msg !== false) infra.pubCh.ack(msg);
  }, 20_000);
});
