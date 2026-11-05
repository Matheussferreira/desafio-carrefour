/**
 * Desligamento gracioso durante o processamento (RNF-10). Publica um lote e desliga o consumidor
 * no meio. Invariante: ao fim, cada evento ou foi aplicado ou continua na fila principal, sem perda,
 * sem duplicidade no saldo e sem nada na DLQ.
 */
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../../src/db';
import { DLQ, QUEUE } from '../../src/rabbitmq';
import { stopConsumer } from '../../src/consumer/lancamentosConsumer';
import { encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEvento } from './helpers';

const TOTAL = 40;

describe('Desligamento gracioso com o consumidor ocupado', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await iniciarInfra();
    await infra.pubCh.purgeQueue(QUEUE);
    await infra.pubCh.purgeQueue(DLQ);
  }, 40_000);

  afterAll(async () => {
    // As mensagens devolvidas à fila não podem vazar para os outros arquivos de teste
    await infra.pubCh.purgeQueue(QUEUE).catch(() => undefined);
    await encerrarInfra(infra);
  });

  it('cada evento do lote foi aplicado ou voltou para a fila, e o saldo bate com o que foi aplicado', async () => {
    const ids = Array.from({ length: TOTAL }, () => uuidv4());
    for (const id of ids) publicarEvento(infra.pubCh, montarEvento(id, '2034-04-04', '10.00'));

    await new Promise(r => setTimeout(r, 150)); // deixa o consumidor começar
    await stopConsumer();
    await new Promise(r => setTimeout(r, 1_500)); // estatísticas da fila e devoluções

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM eventos_processados WHERE evento_id = ANY($1::uuid[])', [ids]);
    const aplicados: number = rows[0].n;
    const fila = await infra.pubCh.checkQueue(QUEUE);
    const dlq = await infra.pubCh.checkQueue(DLQ);

    expect(dlq.messageCount).toBe(0);
    expect(aplicados + fila.messageCount).toBe(TOTAL);

    const saldo = await pool.query('SELECT saldo FROM saldo_diario WHERE data = $1', ['2034-04-04']);
    const esperado = (aplicados * 10).toFixed(2);
    expect(saldo.rows[0]?.saldo ?? '0.00').toBe(aplicados === 0 ? '0.00' : esperado);
  }, 60_000);
});
