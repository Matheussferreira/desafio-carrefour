/**
 * Idempotência do consumidor e invalidação do cache com a chave no formato
 * saldo:{comerciante}:v{versao}:{YYYY-MM-DD}.
 */
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { IdpDeTeste } from '../helpers/idp';
import { pool } from '../../src/db';
import { getRedis } from '../../src/redis';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEAguardar, publicarEvento } from './helpers';

const idp = new IdpDeTeste();
let auth: { Authorization: string };

async function processado(eventoId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [eventoId]);
  return rows.length === 1;
}

describe('Consumidor + cache', () => {
  let infra: Infra;

  beforeAll(async () => {
    await idp.iniciar();
    auth = await idp.cabecalho({ comerciante: 'padrao' });
    infra = await iniciarInfra();
    await getRedis().flushdb();
  }, 40_000);

  afterAll(async () => {
    await idp.parar();
    await encerrarInfra(infra);
  });

  it('o mesmo evento entregue duas vezes altera o saldo uma única vez', async () => {
    const evento = montarEvento(uuidv4(), '2030-05-01', '100.00');
    publicarEvento(infra.pubCh, evento);
    await aguardar(() => processado(evento.eventoId), 10_000);

    publicarEvento(infra.pubCh, evento); // reentrega
    publicarEvento(infra.pubCh, evento);
    const sentinela = montarEvento(uuidv4(), '2030-05-02', '1.00');
    publicarEvento(infra.pubCh, sentinela); // fila é FIFO: quando esta for processada, as repetições já passaram
    await aguardar(() => processado(sentinela.eventoId), 10_000);

    const { rows } = await pool.query(
      'SELECT total_creditos FROM saldo_diario WHERE comerciante_id = $1 AND data = $2',
      ['padrao', '2030-05-01'],
    );
    expect(rows[0].total_creditos).toBe('100.00');
  }, 30_000);

  it('o lançamento seguinte invalida o cache: o GET mostra o saldo novo sem esperar o TTL', async () => {
    const dia = '2031-01-10';

    const e1 = montarEvento(uuidv4(), dia, '100.00');
    await publicarEAguardar(infra.pubCh, e1);

    // 1º GET vem do banco e preenche o cache sob a chave saldo:{comerciante}:v{versao}:{data}
    const primeiro = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(primeiro.status).toBe(200);
    expect(primeiro.body).toMatchObject({ source: 'database', data: dia, totalCreditos: '100.00' });

    const segundo = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(segundo.body.source).toBe('cache');

    // Novo lançamento no mesmo dia: a versão do cache avança e a leitura seguinte vai ao banco
    const e2 = montarEvento(uuidv4(), dia, '50.00');
    await publicarEAguardar(infra.pubCh, e2);

    const terceiro = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(terceiro.body).toMatchObject({
      source: 'database',
      data: dia,
      totalCreditos: '150.00',
      resultadoDia: '150.00',
    });
  }, 30_000);

  it('a data da resposta é YYYY-MM-DD, nunca timestamp', async () => {
    const e = montarEvento(uuidv4(), '2031-02-03', '10.00', 'debito');
    publicarEvento(infra.pubCh, e);
    await aguardar(() => processado(e.eventoId), 10_000);

    const res = await request(app).get('/consolidado/2031-02-03').set(auth);
    expect(res.body.data).toBe('2031-02-03');
    expect(res.body).toMatchObject({ totalDebitos: '10.00', totalCreditos: '0.00', resultadoDia: '-10.00' });
  }, 20_000);
});
