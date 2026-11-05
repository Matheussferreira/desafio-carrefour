/**
 * Desligamento gracioso do consumidor (RNF-10), contra RabbitMQ e Postgres reais.
 * O estado de desligamento é do módulo, então cada cenário de desligamento fica no seu arquivo.
 *
 * Invariante que se verifica: depois de stopConsumer, toda mensagem publicada ou foi aplicada, ou
 * voltou para a fila principal. Nenhuma se perde e nenhuma vai para a DLQ.
 */
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../../src/db';
import { DLQ, QUEUE } from '../../src/rabbitmq';
import { stopConsumer } from '../../src/consumer/lancamentosConsumer';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEvento } from './helpers';

function urlDeAdministracao(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = '/postgres';
  return url.toString();
}

const nomeDoBanco = (): string => new URL(process.env.DATABASE_URL as string).pathname.slice(1);

async function alterarBanco(permitir: boolean): Promise<void> {
  const admin = new Client({ connectionString: urlDeAdministracao() });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE ${nomeDoBanco()} ALLOW_CONNECTIONS ${permitir}`);
    if (!permitir) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
        nomeDoBanco(),
      ]);
    }
  } finally {
    await admin.end();
  }
}

describe('Desligamento gracioso do consumidor', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await iniciarInfra();
    await infra.pubCh.purgeQueue(QUEUE);
    await infra.pubCh.purgeQueue(DLQ);
  }, 40_000);

  afterAll(async () => {
    // As mensagens devolvidas à fila não podem vazar para os outros arquivos de teste
    await infra.pubCh.purgeQueue(QUEUE).catch(() => undefined);
    await alterarBanco(true);
    await encerrarInfra(infra);
  });

  it('com o banco fora, a mensagem retida volta para a fila ao desligar e não vai para a DLQ', async () => {
    const id = uuidv4();
    await alterarBanco(false);
    publicarEvento(infra.pubCh, montarEvento(id, '2033-03-03', '55.00'));

    // Espera o consumidor pegar a mensagem (ela fica retida, sem ack) e então desliga
    await aguardar(async () => (await infra.pubCh.checkQueue(QUEUE)).messageCount === 0, 10_000);
    await new Promise(r => setTimeout(r, 1_500));

    const inicio = Date.now();
    await stopConsumer();
    // Não espera o prazo de 8 s: a espera por falha transitória é interrompida
    expect(Date.now() - inicio).toBeLessThan(5_000);

    await aguardar(async () => (await infra.pubCh.checkQueue(QUEUE)).messageCount === 1, 10_000);
    expect((await infra.pubCh.checkQueue(DLQ)).messageCount).toBe(0);

    await alterarBanco(true);
    const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [id]);
    expect(rows).toHaveLength(0); // não foi aplicado: continua na fila para o próximo processo
  }, 60_000);
});
