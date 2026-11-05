/**
 * Isolamento entre comerciantes no serviço de lançamentos: o comerciante vem do token,
 * a chave de idempotência vale por comerciante e o evento carrega comercianteId (schema 1.1).
 */
import request from 'supertest';
import app from '../../src/app';
import { IdpDeTeste } from '../helpers/idp';
import { pool } from '../../src/db';
import { runMigrations } from '../../src/migrations';

const idp = new IdpDeTeste();
let loja1: { Authorization: string };
let loja2: { Authorization: string };
const corpo = { valor: '80.00', tipo: 'credito', data: '2026-04-01', descricao: 'Venda' };

beforeAll(async () => {
  await idp.iniciar();
  loja1 = await idp.cabecalho({ comerciante: 'loja-1' });
  loja2 = await idp.cabecalho({ comerciante: 'loja-2' });
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE lancamentos, outbox');
});

afterAll(async () => {
  await idp.parar();
  await pool.end();
});

describe('comerciante vem do token', () => {
  it('grava o lançamento e o evento com o comerciante do token', async () => {
    const res = await request(app).post('/lancamentos').set(loja1).send(corpo);
    expect(res.status).toBe(201);

    const { rows: lanc } = await pool.query('SELECT comerciante_id FROM lancamentos');
    expect(lanc).toEqual([{ comerciante_id: 'loja-1' }]);

    const { rows: ev } = await pool.query('SELECT payload FROM outbox');
    expect(ev[0].payload).toMatchObject({
      schemaVersion: '1.1',
      comercianteId: 'loja-1',
      data: { data: '2026-04-01', valor: '80.00' },
    });
  });

  it('ignora comerciante informado no corpo da requisição', async () => {
    await request(app)
      .post('/lancamentos')
      .set(loja1)
      .send({ ...corpo, comercianteId: 'loja-2', comerciante_id: 'loja-2', comerciante: 'loja-2' });

    const { rows } = await pool.query('SELECT comerciante_id FROM lancamentos');
    expect(rows).toEqual([{ comerciante_id: 'loja-1' }]);
  });

  it('listagem mostra só os lançamentos do comerciante autenticado', async () => {
    await request(app).post('/lancamentos').set(loja1).send(corpo);
    await request(app).post('/lancamentos').set(loja1).send({ ...corpo, valor: '1.00' });
    await request(app).post('/lancamentos').set(loja2).send({ ...corpo, valor: '999.00' });

    const a = await request(app).get('/lancamentos?data=2026-04-01').set(loja1);
    const b = await request(app).get('/lancamentos?data=2026-04-01').set(loja2);
    const semFiltro = await request(app).get('/lancamentos').set(loja2);

    expect(a.body.itens).toHaveLength(2);
    expect(b.body.itens).toHaveLength(1);
    expect(b.body.itens[0].valor).toBe('999.00');
    expect(semFiltro.body.itens).toHaveLength(1);
  });
});

describe('idempotência escopada por comerciante', () => {
  it('a mesma chave em comerciantes diferentes cria dois lançamentos', async () => {
    const chave = { 'X-Idempotency-Key': 'pedido-1' };
    const a = await request(app).post('/lancamentos').set(loja1).set(chave).send(corpo);
    const b = await request(app).post('/lancamentos').set(loja2).set(chave).send({ ...corpo, valor: '5.00' });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201); // sem 409: a chave de outro comerciante não conta
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('no mesmo comerciante, reenvio devolve o original e corpo diferente dá 409', async () => {
    const chave = { 'X-Idempotency-Key': 'pedido-2' };
    const a = await request(app).post('/lancamentos').set(loja1).set(chave).send(corpo);
    const reenvio = await request(app).post('/lancamentos').set(loja1).set(chave).send(corpo);
    const conflito = await request(app).post('/lancamentos').set(loja1).set(chave).send({ ...corpo, valor: '9.00' });

    expect(reenvio.status).toBe(200);
    expect(reenvio.body.id).toBe(a.body.id);
    expect(conflito.status).toBe(409);
  });
});

describe('migration 003 sobre dados existentes', () => {
  it('a restrição de unicidade passou a ser (comerciante_id, idempotency_key)', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'lancamentos'::regclass AND contype = 'u'`,
    );
    expect(rows.map(r => r.def)).toEqual(['UNIQUE (comerciante_id, idempotency_key)']);
  });
});
