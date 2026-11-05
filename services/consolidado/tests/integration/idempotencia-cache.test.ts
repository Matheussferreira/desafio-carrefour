/**
 * Idempotência do consumidor e invalidação do cache com a chave no formato YYYY-MM-DD.
 */
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { getRedis } from '../../src/redis';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEvento } from './helpers';

const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'teste' }, config.jwtSecret)}` };

async function processado(eventoId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [eventoId]);
  return rows.length === 1;
}

describe('Consumidor + cache', () => {
  let infra: Infra;

  beforeAll(async () => {
    infra = await iniciarInfra();
    await getRedis().flushdb();
  }, 40_000);

  afterAll(async () => {
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

    const { rows } = await pool.query('SELECT total_creditos FROM saldo_diario WHERE data = $1', ['2030-05-01']);
    expect(rows[0].total_creditos).toBe('100.00');
  }, 30_000);

  it('o lançamento seguinte invalida o cache: o GET mostra o saldo novo sem esperar o TTL', async () => {
    const dia = '2031-01-10';

    const e1 = montarEvento(uuidv4(), dia, '100.00');
    publicarEvento(infra.pubCh, e1);
    await aguardar(() => processado(e1.eventoId), 10_000);

    // 1º GET vem do banco e preenche o cache sob a chave saldo:YYYY-MM-DD
    const primeiro = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(primeiro.status).toBe(200);
    expect(primeiro.body).toMatchObject({ source: 'database', data: dia, total_creditos: '100.00' });
    expect(await getRedis().get(`saldo:${dia}`)).not.toBeNull();

    const segundo = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(segundo.body.source).toBe('cache');

    // Novo lançamento no mesmo dia: o consumidor tem que apagar exatamente essa chave
    const e2 = montarEvento(uuidv4(), dia, '50.00');
    publicarEvento(infra.pubCh, e2);
    await aguardar(() => processado(e2.eventoId), 10_000);
    expect(await getRedis().get(`saldo:${dia}`)).toBeNull();

    const terceiro = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(terceiro.body).toMatchObject({ source: 'database', data: dia, total_creditos: '150.00', saldo: '150.00' });
  }, 30_000);

  it('a data da resposta é YYYY-MM-DD, nunca timestamp', async () => {
    const e = montarEvento(uuidv4(), '2031-02-03', '10.00', 'debito');
    publicarEvento(infra.pubCh, e);
    await aguardar(() => processado(e.eventoId), 10_000);

    const res = await request(app).get('/consolidado/2031-02-03').set(auth);
    expect(res.body.data).toBe('2031-02-03');
    expect(res.body).toMatchObject({ total_debitos: '10.00', total_creditos: '0.00', saldo: '-10.00' });
  }, 20_000);

  it('dia sem movimento continua devolvendo 404 problem+json (muda na fase 2)', async () => {
    const res = await request(app).get('/consolidado/1999-12-31').set(auth);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});
