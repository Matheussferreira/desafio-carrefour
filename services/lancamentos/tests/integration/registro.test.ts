/**
 * Integração com Postgres real: atomicidade lançamento + outbox, formato da data,
 * idempotência (inclusive concorrente) e contrato HTTP.
 */
import request from 'supertest';
import app from '../../src/app';
import { IdpDeTeste } from '../helpers/idp';
import { pool } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import {
  ConflitoIdempotenciaError,
  registrarLancamento,
} from '../../src/domain/lancamentoService';

const M = 'loja-a';
const idp = new IdpDeTeste();
let auth: { Authorization: string };
const base = { valor: '120.50', tipo: 'credito' as const, data: '2026-03-10', descricao: 'Venda' };

async function contar(tabela: 'lancamentos' | 'outbox'): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${tabela}`);
  return Number(rows[0].n);
}

beforeAll(async () => {
  await idp.iniciar();
  auth = await idp.cabecalho({ comerciante: M });
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE lancamentos, outbox');
});

afterAll(async () => {
  await idp.parar();
  await pool.end();
});

describe('registro transacional', () => {
  it('grava lançamento e evento no outbox com o mesmo conteúdo', async () => {
    const { criado, lancamento } = await registrarLancamento(pool, M, base, { correlationId: 'corr-1' });

    expect(criado).toBe(true);
    expect(lancamento.data).toBe('2026-03-10');
    expect(await contar('lancamentos')).toBe(1);
    expect(await contar('outbox')).toBe(1);

    const { rows } = await pool.query('SELECT id, status, payload FROM outbox');
    expect(rows[0].status).toBe('pendente');
    expect(rows[0].payload.eventoId).toBe(rows[0].id);
    expect(rows[0].payload.correlationId).toBe('corr-1');
    expect(rows[0].payload.data).toMatchObject({
      lancamentoId: lancamento.id,
      valor: '120.50',
      tipo: 'credito',
      data: '2026-03-10', // YYYY-MM-DD, nunca timestamp
    });
  });

  it('se a gravação do outbox falhar, o lançamento também é desfeito', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION falhar_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'falha simulada no outbox'; END;
      $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER trg_falhar_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION falhar_outbox()');

    try {
      await expect(registrarLancamento(pool, M, base, { correlationId: 'corr-2' })).rejects.toThrow(
        'falha simulada no outbox',
      );
      expect(await contar('lancamentos')).toBe(0);
      expect(await contar('outbox')).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER trg_falhar_outbox ON outbox');
      await pool.query('DROP FUNCTION falhar_outbox()');
    }

    // Com o defeito removido, o mesmo pedido volta a funcionar
    const ok = await registrarLancamento(pool, M, base, { correlationId: 'corr-2' });
    expect(ok.criado).toBe(true);
    expect(await contar('outbox')).toBe(1);
  });
});

describe('idempotência', () => {
  it('mesma chave e mesmo corpo devolve o original sem criar evento novo', async () => {
    const primeiro = await registrarLancamento(pool, M, base, { correlationId: 'a', idempotencyKey: 'k1' });
    const segundo = await registrarLancamento(pool, M, { ...base, valor: '120.5' }, { correlationId: 'b', idempotencyKey: 'k1' });

    expect(segundo.criado).toBe(false);
    expect(segundo.lancamento.id).toBe(primeiro.lancamento.id);
    expect(await contar('lancamentos')).toBe(1);
    expect(await contar('outbox')).toBe(1);
  });

  it('mesma chave com corpo diferente lança conflito e não grava nada', async () => {
    await registrarLancamento(pool, M, base, { correlationId: 'a', idempotencyKey: 'k2' });

    await expect(
      registrarLancamento(pool, M, { ...base, valor: '999.00' }, { correlationId: 'b', idempotencyKey: 'k2' }),
    ).rejects.toBeInstanceOf(ConflitoIdempotenciaError);

    expect(await contar('lancamentos')).toBe(1);
    expect(await contar('outbox')).toBe(1);
  });

  it('dez requisições simultâneas com a mesma chave geram um único lançamento', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        registrarLancamento(pool, M, base, { correlationId: `c${i}`, idempotencyKey: 'k3' }),
      ),
    );

    expect(new Set(resultados.map(r => r.lancamento.id)).size).toBe(1);
    expect(resultados.filter(r => r.criado)).toHaveLength(1);
    expect(await contar('lancamentos')).toBe(1);
    expect(await contar('outbox')).toBe(1);
  });

  it('sem chave, cada requisição cria um lançamento', async () => {
    await registrarLancamento(pool, M, base, { correlationId: 'a' });
    await registrarLancamento(pool, M, base, { correlationId: 'b' });
    expect(await contar('lancamentos')).toBe(2);
  });
});

describe('contrato HTTP', () => {
  it('POST devolve 201 com data em YYYY-MM-DD e GET lista no mesmo formato', async () => {
    const post = await request(app).post('/lancamentos').set(auth).send(base);
    expect(post.status).toBe(201);
    expect(post.body.data).toBe('2026-03-10');
    expect(post.body.valor).toBe('120.50');

    const get = await request(app).get('/lancamentos?data=2026-03-10').set(auth);
    expect(get.status).toBe(200);
    expect(get.body.itens[0].data).toBe('2026-03-10');
    expect(get.body.proximoCursor).toBeNull();
  });

  it('reenvio idêntico devolve 200 e cabeçalho Idempotent-Replayed', async () => {
    const chave = { 'X-Idempotency-Key': 'http-1' };
    const a = await request(app).post('/lancamentos').set(auth).set(chave).send(base);
    const b = await request(app).post('/lancamentos').set(auth).set(chave).send(base);

    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
  });

  it('chave reutilizada com outro corpo devolve 409 problem+json', async () => {
    const chave = { 'X-Idempotency-Key': 'http-2' };
    await request(app).post('/lancamentos').set(auth).set(chave).send(base);
    const res = await request(app).post('/lancamentos').set(auth).set(chave).send({ ...base, valor: '1.00' });

    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toBe('/problems/idempotency-key-conflict');
    expect(await contar('lancamentos')).toBe(1);
  });
});
