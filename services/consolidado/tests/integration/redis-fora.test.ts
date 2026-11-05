/**
 * O Redis é uma dependência degradável: sem ele o consolidado continua pronto (/ready 200) e as
 * leituras vêm do banco. Aqui o cliente do Redis é desligado de verdade, então cada comando falha
 * na hora (sem fila offline), exatamente como numa queda do servidor.
 */
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { pool } from '../../src/db';
import { epocaAtual, gravarSaldo, referenciaAtual } from '../../src/cache/saldoCache';
import { consultarDia } from '../../src/domain/saldoQueries';
import { connectRedis, getRedis } from '../../src/redis';
import { IdpDeTeste } from '../helpers/idp';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEvento } from './helpers';

const idp = new IdpDeTeste();
const DATA = '2031-05-05';
const LOJA = 'loja-redis';

describe('Redis fora do ar', () => {
  let infra: Infra;
  let auth: { Authorization: string };

  beforeAll(async () => {
    await idp.iniciar();
    auth = await idp.cabecalho({ comerciante: LOJA });
    infra = await iniciarInfra();
  }, 40_000);

  afterAll(async () => {
    await idp.parar();
    await encerrarInfra(infra);
  });

  it('/ready continua 200 e o GET vem do banco, rápido; o evento recebido sem Redis também é aplicado', async () => {
    const e1 = montarEvento(uuidv4(), DATA, '100.00', 'credito', { comercianteId: LOJA });
    publicarEvento(infra.pubCh, e1);
    await aguardar(async () => (await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [e1.eventoId])).rows.length === 1);

    // Derruba o Redis: o cliente fica sem conexão e sem reconectar
    getRedis().disconnect();

    expect((await request(app).get('/ready')).status).toBe(200);

    const inicio = Date.now();
    const antes = await request(app).get(`/consolidado/${DATA}`).set(auth);
    expect(Date.now() - inicio).toBeLessThan(3_000);
    expect(antes.status).toBe(200);
    expect(antes.body).toMatchObject({ source: 'database', totalCreditos: '100.00' });

    // Um evento novo chega com o Redis fora: o processamento não depende dele
    const e2 = montarEvento(uuidv4(), DATA, '25.00', 'credito', { comercianteId: LOJA });
    publicarEvento(infra.pubCh, e2);
    await aguardar(async () => (await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [e2.eventoId])).rows.length === 1);

    const depois = await request(app).get(`/consolidado/${DATA}`).set(auth);
    expect(depois.status).toBe(200);
    expect(depois.body).toMatchObject({ source: 'database', totalCreditos: '125.00' });

    const intervalo = await request(app).get(`/consolidado?inicio=${DATA}&fim=${DATA}`).set(auth);
    expect(intervalo.status).toBe(200);

    // O Redis volta: a leitura passa a usar o cache de novo
    await connectRedis();
    const retomada = await request(app).get(`/consolidado/${DATA}`).set(auth);
    expect(retomada.status).toBe(200);
    expect(retomada.body.totalCreditos).toBe('125.00');
  }, 40_000);

  it('na reconexão a época do cache sobe e uma entrada antiga deixa de ser servida em poucos segundos', async () => {
    const dia = '2031-06-06';
    const e = montarEvento(uuidv4(), dia, '40.00', 'credito', { comercianteId: LOJA });
    publicarEvento(infra.pubCh, e);
    await aguardar(async () => (await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [e.eventoId])).rows.length === 1);

    // Entrada velha sob a referência vigente, como a que sobrevive a uma queda do Redis
    const ref = await referenciaAtual(LOJA);
    await gravarSaldo(LOJA, ref, dia, { ...(await consultarDia(pool, LOJA, dia)), totalCreditos: '1.00' });
    const velha = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(velha.body).toMatchObject({ source: 'cache', totalCreditos: '1.00' });

    // Queda e volta do cliente: o evento 'ready' depois de um 'close' avança a época
    const inicio = Date.now();
    const redis = getRedis();
    redis.disconnect();
    await aguardar(async () => redis.status === 'end', 5_000);
    await redis.connect();
    await aguardar(async () => (await epocaAtual()) !== ref.epoca, 5_000);

    const depois = await request(app).get(`/consolidado/${dia}`).set(auth);
    expect(Date.now() - inicio).toBeLessThan(5_000);
    expect(depois.body).toMatchObject({ source: 'database', totalCreditos: '40.00' });
  }, 40_000);
});
