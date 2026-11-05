/**
 * Confere respostas reais da API (Postgres real) contra os schemas do openapi.yaml.
 */
import request from 'supertest';
import app from '../../src/app';
import { pool } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { IdpDeTeste } from '../helpers/idp';
import { carregarSpec, errosDoContrato } from '../helpers/openapi';

const idp = new IdpDeTeste();
let auth: { Authorization: string };
let spec: Awaited<ReturnType<typeof carregarSpec>>;
const corpo = { valor: '150.00', tipo: 'credito', descricao: 'Venda', data: '2026-06-15' };

const confere = (caminho: string, metodo: string, res: request.Response) =>
  errosDoContrato(spec, caminho, metodo, res.status, (res.headers['content-type'] ?? '').split(';')[0], res.body);

beforeAll(async () => {
  spec = await carregarSpec();
  await idp.iniciar();
  auth = await idp.cabecalho({ comerciante: 'loja-contrato' });
  await runMigrations(pool);
  await pool.query('TRUNCATE lancamentos, outbox');
});

afterAll(async () => {
  await idp.parar();
  await pool.end();
});

describe('respostas reais conferem com a spec', () => {
  it('POST 201 e reenvio idempotente 200', async () => {
    const chave = { 'X-Idempotency-Key': 'contrato-1' };
    const criado = await request(app).post('/lancamentos').set(auth).set(chave).send(corpo);
    const reenvio = await request(app).post('/lancamentos').set(auth).set(chave).send(corpo);
    expect(criado.status).toBe(201);
    expect(reenvio.status).toBe(200);
    expect(confere('/lancamentos', 'post', criado)).toEqual([]);
    expect(confere('/lancamentos', 'post', reenvio)).toEqual([]);
  });

  it('GET paginado, com e sem próxima página', async () => {
    for (let i = 0; i < 3; i++) await request(app).post('/lancamentos').set(auth).send({ ...corpo, valor: `${i + 1}.00` });
    const primeira = await request(app).get('/lancamentos?limite=2').set(auth);
    expect(primeira.body.proximoCursor).not.toBeNull();
    const ultima = await request(app).get(`/lancamentos?limite=50&cursor=${primeira.body.proximoCursor}`).set(auth);
    expect(ultima.body.proximoCursor).toBeNull();
    expect(confere('/lancamentos', 'get', primeira)).toEqual([]);
    expect(confere('/lancamentos', 'get', ultima)).toEqual([]);
  });

  it('erros: 400 de validação, 409 de conflito, 401 sem token e 403 sem escopo', async () => {
    const invalido = await request(app).post('/lancamentos').set(auth).send({ ...corpo, valor: 150 });
    const chave = { 'X-Idempotency-Key': 'contrato-409' };
    await request(app).post('/lancamentos').set(auth).set(chave).send(corpo);
    const conflito = await request(app).post('/lancamentos').set(auth).set(chave).send({ ...corpo, valor: '999.00' });
    const semToken = await request(app).get('/lancamentos');
    const semEscopo = await request(app)
      .get('/lancamentos')
      .set(await idp.cabecalho({ comerciante: 'loja-contrato', escopos: ['outro.escopo'] }));

    expect([invalido.status, conflito.status, semToken.status, semEscopo.status]).toEqual([400, 409, 401, 403]);
    expect(confere('/lancamentos', 'post', invalido)).toEqual([]);
    expect(confere('/lancamentos', 'post', conflito)).toEqual([]);
    expect(confere('/lancamentos', 'get', semToken)).toEqual([]);
    expect(confere('/lancamentos', 'get', semEscopo)).toEqual([]);
  });

  it('cursor inválido e limite fora do intervalo seguem o schema de problema', async () => {
    const cursor = await request(app).get('/lancamentos?cursor=xxx').set(auth);
    const limite = await request(app).get('/lancamentos?limite=1000').set(auth);
    expect(confere('/lancamentos', 'get', cursor)).toEqual([]);
    expect(confere('/lancamentos', 'get', limite)).toEqual([]);
  });

  it('o validador pega divergência (a spec não aceita qualquer corpo)', () => {
    const erros = errosDoContrato(spec, '/lancamentos', 'post', 201, 'application/json', { id: 'não é uuid', valor: 12 });
    expect(erros.length).toBeGreaterThan(0);
  });

  it('/health e /ready', async () => {
    const health = await request(app).get('/health');
    const ready = await request(app).get('/ready');
    expect(confere('/health', 'get', health)).toEqual([]);
    expect(confere('/ready', 'get', ready)).toEqual([]);
  });
});
