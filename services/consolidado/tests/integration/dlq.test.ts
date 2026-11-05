/**
 * Retry, espera por falha transitória e Dead Letter Queue contra um RabbitMQ e um Postgres reais.
 * Pré-requisito: docker-compose.integration.yml no ar (use test-integration.ps1 ou .sh).
 *
 * Regra que estes testes fixam: a DLQ é só para mensagem que nunca vai passar (JSON quebrado,
 * contrato inválido, erro permanente de processamento). Banco fora ou conexão derrubada deixa a
 * mensagem retida até o banco voltar.
 */
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../../src/db';
import { DLQ } from '../../src/rabbitmq';
import { consumerDlqTotal, consumerRetriesTotal, consumerTransientTotal } from '../../src/metrics';
import {
  aguardar,
  encerrarInfra,
  iniciarInfra,
  Infra,
  montarEvento,
  publicarEvento,
  valorContador,
} from './helpers';

function urlDeAdministracao(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = '/postgres';
  return url.toString();
}

function nomeDoBanco(): string {
  return new URL(process.env.DATABASE_URL as string).pathname.slice(1);
}

/** Bloqueia novas conexões ao banco do serviço e derruba as abertas, sem tocar nos outros bancos. */
async function derrubarBanco(): Promise<void> {
  const admin = new Client({ connectionString: urlDeAdministracao() });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE ${nomeDoBanco()} ALLOW_CONNECTIONS false`);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
      nomeDoBanco(),
    ]);
  } finally {
    await admin.end();
  }
}

async function religarBanco(): Promise<void> {
  const admin = new Client({ connectionString: urlDeAdministracao() });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE ${nomeDoBanco()} ALLOW_CONNECTIONS true`);
  } finally {
    await admin.end();
  }
}

describe('Retry, espera por falha transitória e Dead Letter Queue', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await iniciarInfra();
  }, 40_000);

  beforeEach(async () => {
    await infra.pubCh.purgeQueue(DLQ);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await religarBanco();
  });

  afterAll(async () => {
    await encerrarInfra(infra);
  });

  it('erro permanente de processamento: tenta 3 vezes com backoff e manda a mensagem intacta para a DLQ', async () => {
    const baseRetries = await valorContador(consumerRetriesTotal);
    const baseDlq = await valorContador(consumerDlqTotal);

    // Erro sem código de infraestrutura: o consumidor o trata como permanente
    const spy = jest.spyOn(pool, 'connect').mockRejectedValue(new Error('falha permanente simulada') as never);
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

  it('erro transitório simulado: a mensagem fica retida, não vai para a DLQ e é aplicada quando a conexão volta', async () => {
    const baseDlq = await valorContador(consumerDlqTotal);
    const baseRetries = await valorContador(consumerRetriesTotal);
    const baseTransitorio = await valorContador(consumerTransientTotal);

    const falha = Object.assign(new Error('banco indisponível (simulado)'), { code: '57P03' });
    const spy = jest.spyOn(pool, 'connect').mockRejectedValue(falha as never);
    const eventoId = uuidv4();
    publicarEvento(infra.pubCh, montarEvento(eventoId, '2024-07-01', '42.00'));

    // Passa bem do tempo em que a regra antiga (3 retries em 7 s) já teria mandado para a DLQ
    await aguardar(async () => (await valorContador(consumerTransientTotal)) - baseTransitorio >= 3, 15_000);
    expect((await infra.pubCh.checkQueue(DLQ)).messageCount).toBe(0);
    spy.mockRestore();

    await aguardar(async () => {
      const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [eventoId]);
      return rows.length === 1;
    }, 25_000);

    expect((await valorContador(consumerDlqTotal)) - baseDlq).toBe(0);
    expect((await valorContador(consumerRetriesTotal)) - baseRetries).toBe(0);
    expect((await infra.pubCh.checkQueue(DLQ)).messageCount).toBe(0);
    const { rows } = await pool.query('SELECT saldo FROM saldo_diario WHERE data = $1', ['2024-07-01']);
    expect(rows).toEqual([{ saldo: '42.00' }]);
  }, 60_000);

  it('banco realmente fora por alguns segundos: eventos publicados no período convergem na volta, sem nada na DLQ', async () => {
    const baseDlq = await valorContador(consumerDlqTotal);
    const ids = [uuidv4(), uuidv4(), uuidv4()];

    await derrubarBanco();
    for (const id of ids) publicarEvento(infra.pubCh, montarEvento(id, '2024-08-10', '100.00'));
    // Mais que os 7 s em que a regra antiga já teria esgotado as tentativas
    await new Promise(r => setTimeout(r, 9_000));
    expect((await infra.pubCh.checkQueue(DLQ)).messageCount).toBe(0);
    await religarBanco();

    await aguardar(async () => {
      try {
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM eventos_processados WHERE evento_id = ANY($1::uuid[])', [
          ids,
        ]);
        return rows[0].n === 3;
      } catch {
        return false; // o pool ainda está reconectando
      }
    }, 40_000);

    const { rows } = await pool.query('SELECT saldo FROM saldo_diario WHERE data = $1', ['2024-08-10']);
    expect(rows).toEqual([{ saldo: '300.00' }]);
    expect((await valorContador(consumerDlqTotal)) - baseDlq).toBe(0);
    expect((await infra.pubCh.checkQueue(DLQ)).messageCount).toBe(0);
  }, 90_000);

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

  it('evento de versão maior incompatível (2.x) vai direto para a DLQ', async () => {
    const eventoId = uuidv4();
    const evento: { eventoId: string; schemaVersion?: string } = montarEvento(eventoId, '2024-06-17', '10.00');
    evento.schemaVersion = '2.0';
    publicarEvento(infra.pubCh, evento);

    await aguardar(async () => (await infra.pubCh.checkQueue(DLQ)).messageCount === 1, 10_000);
    const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [eventoId]);
    expect(rows).toHaveLength(0);

    const msg = await infra.pubCh.get(DLQ, { noAck: false });
    if (msg !== false) infra.pubCh.ack(msg);
  }, 20_000);
});
