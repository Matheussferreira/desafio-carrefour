/**
 * Paginação por cursor de GET /lancamentos contra um Postgres real: ordem estável, sem repetir nem
 * pular linhas (inclusive com o mesmo instante de criação), filtro por data, isolamento entre
 * comerciantes e validação dos parâmetros.
 */
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { pool } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { IdpDeTeste } from '../helpers/idp';

const idp = new IdpDeTeste();
let authA: { Authorization: string };
let authB: { Authorization: string };

async function inserir(comerciante: string, data: string, criadoEm: string): Promise<string> {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO lancamentos (id, comerciante_id, valor, tipo, data, created_at)
     VALUES ($1, $2, 10.00, 'credito', $3, $4)`,
    [id, comerciante, data, criadoEm],
  );
  return id;
}

async function percorrer(auth: { Authorization: string }, consulta: string): Promise<{ ids: string[]; paginas: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let paginas = 0;
  do {
    const sufixo: string = cursor ? `&cursor=${cursor}` : '';
    const res = await request(app).get(`/lancamentos?${consulta}${sufixo}`).set(auth);
    expect(res.status).toBe(200);
    ids.push(...res.body.itens.map((i: { id: string }) => i.id));
    cursor = res.body.proximoCursor;
    paginas++;
    expect(paginas).toBeLessThan(50);
  } while (cursor);
  return { ids, paginas };
}

beforeAll(async () => {
  await idp.iniciar();
  authA = await idp.cabecalho({ comerciante: 'loja-pag-a' });
  authB = await idp.cabecalho({ comerciante: 'loja-pag-b' });
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE lancamentos, outbox');
});

afterAll(async () => {
  await idp.parar();
  await pool.end();
});

describe('GET /lancamentos paginado', () => {
  it('percorre tudo na ordem do mais recente ao mais antigo, sem repetir nem pular, mesmo com instantes iguais', async () => {
    const mesmoInstante = '2026-03-10T12:00:00.123456Z';
    await inserir('loja-pag-a', '2026-03-10', '2026-03-10T10:00:00.000001Z');
    for (let i = 0; i < 4; i++) await inserir('loja-pag-a', '2026-03-10', mesmoInstante); // desempate pelo id
    await inserir('loja-pag-a', '2026-03-11', '2026-03-11T09:00:00.000000Z');
    await inserir('loja-pag-a', '2026-03-11', '2026-03-11T09:00:00.000001Z');
    await inserir('loja-pag-b', '2026-03-10', '2026-03-10T13:00:00Z'); // outro comerciante não aparece

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM lancamentos WHERE comerciante_id = 'loja-pag-a' ORDER BY created_at DESC, id DESC",
    );
    const esperado = rows.map(r => r.id);
    expect(esperado).toHaveLength(7);

    const { ids, paginas } = await percorrer(authA, 'limite=3');
    expect(ids).toEqual(esperado);
    expect(new Set(ids).size).toBe(7);
    expect(paginas).toBe(3); // 3 + 3 + 1
  });

  it('com a quantidade exata de itens, a última página não promete outra', async () => {
    for (let i = 0; i < 4; i++) await inserir('loja-pag-a', '2026-04-01', `2026-04-01T10:00:0${i}.000000Z`);

    const p1 = await request(app).get('/lancamentos?limite=2').set(authA);
    expect(p1.body.itens).toHaveLength(2);
    expect(p1.body.proximoCursor).not.toBeNull();
    const p2 = await request(app).get(`/lancamentos?limite=2&cursor=${p1.body.proximoCursor}`).set(authA);
    expect(p2.body.itens).toHaveLength(2);
    expect(p2.body.proximoCursor).toBeNull();
  });

  it('filtra por data e pagina dentro do filtro', async () => {
    for (let i = 0; i < 5; i++) await inserir('loja-pag-a', '2026-05-01', `2026-05-01T08:00:0${i}.000000Z`);
    for (let i = 0; i < 3; i++) await inserir('loja-pag-a', '2026-05-02', `2026-05-02T08:00:0${i}.000000Z`);

    const { ids } = await percorrer(authA, 'data=2026-05-01&limite=2');
    expect(ids).toHaveLength(5);
    const { rows } = await pool.query<{ data: string }>('SELECT data FROM lancamentos WHERE id = ANY($1::uuid[])', [ids]);
    expect(new Set(rows.map(r => r.data))).toEqual(new Set(['2026-05-01']));
  });

  it('o limite padrão é 50 e o máximo é 100', async () => {
    await pool.query(
      `INSERT INTO lancamentos (comerciante_id, valor, tipo, data, created_at)
       SELECT 'loja-pag-a', 1.00, 'credito', '2026-06-01', now() - (g || ' seconds')::interval FROM generate_series(1, 120) g`,
    );
    const padrao = await request(app).get('/lancamentos').set(authA);
    expect(padrao.body.itens).toHaveLength(50);
    const maximo = await request(app).get('/lancamentos?limite=100').set(authA);
    expect(maximo.body.itens).toHaveLength(100);
    expect(maximo.body.proximoCursor).not.toBeNull();
  });

  it('um cursor de outro comerciante não vaza dados: só devolve linhas do dono do token', async () => {
    for (let i = 0; i < 3; i++) await inserir('loja-pag-a', '2026-07-01', `2026-07-01T10:00:0${i}.000000Z`);
    for (let i = 0; i < 3; i++) await inserir('loja-pag-b', '2026-07-01', `2026-07-01T10:00:0${i}.000000Z`);

    const a = await request(app).get('/lancamentos?limite=1').set(authA);
    const comCursorDeA = await request(app).get(`/lancamentos?limite=5&cursor=${a.body.proximoCursor}`).set(authB);

    expect(comCursorDeA.status).toBe(200);
    const { rows } = await pool.query<{ comerciante_id: string }>(
      'SELECT DISTINCT comerciante_id FROM lancamentos WHERE id = ANY($1::uuid[])',
      [comCursorDeA.body.itens.map((i: { id: string }) => i.id)],
    );
    expect(rows).toEqual([{ comerciante_id: 'loja-pag-b' }]);
  });

  it.each([
    ['limite=0', 'limite zero'],
    ['limite=101', 'limite acima do máximo'],
    ['limite=abc', 'limite que não é número'],
    ['cursor=invalido', 'cursor que não foi emitido pelo serviço'],
    ['data=2026-02-30', 'data que não existe'],
  ])('%s responde 400 problem+json (%s)', async consulta => {
    const res = await request(app).get(`/lancamentos?${consulta}`).set(authA);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('a listagem usa o índice da paginação, sem ordenar a tabela inteira', async () => {
    await pool.query(
      `INSERT INTO lancamentos (comerciante_id, valor, tipo, data, created_at)
       SELECT 'loja-pag-a', 1.00, 'credito', '2026-06-01', now() - (g || ' seconds')::interval FROM generate_series(1, 5000) g`,
    );
    await pool.query('ANALYZE lancamentos');
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM lancamentos WHERE comerciante_id = 'loja-pag-a' ORDER BY created_at DESC, id DESC LIMIT 51`,
    );
    const plano = rows.map(r => r['QUERY PLAN']).join('\n');
    expect(plano).toMatch(/idx_lancamentos_comerciante_criado/);
    expect(plano).not.toMatch(/Sort/);
  });
});
