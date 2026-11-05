import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';
import { config } from '../../src/config';

// Estes cenários terminam na validação, antes de qualquer acesso ao banco.
const token = jwt.sign({ sub: 'teste', comerciante_id: 'loja-a' }, config.jwtSecret);
const auth = { Authorization: `Bearer ${token}` };

describe('POST /lancamentos: erros viram 400 problem+json', () => {
  it('data inexistente no calendário', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .set(auth)
      .send({ valor: '10.00', tipo: 'credito', data: '2026-02-30' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ type: '/problems/validation-error', status: 400 });
    expect(res.body.errors).toEqual([
      { campo: 'data', mensagem: 'data deve ser uma data real no formato YYYY-MM-DD' },
    ]);
  });

  it('valor acima do limite não estoura o banco: é 400, não 500', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .set(auth)
      .send({ valor: '99999999999999999.00', tipo: 'credito', data: '2026-06-15' });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].campo).toBe('valor');
  });

  it('valor numérico é recusado', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .set(auth)
      .send({ valor: 10.5, tipo: 'credito', data: '2026-06-15' });

    expect(res.status).toBe(400);
  });

  it('JSON malformado', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"valor": ');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toBe('/problems/invalid-json');
  });

  it('chave de idempotência longa demais', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .set(auth)
      .set('X-Idempotency-Key', 'k'.repeat(256))
      .send({ valor: '10.00', tipo: 'credito', data: '2026-06-15' });

    expect(res.status).toBe(400);
    expect(res.body.type).toBe('/problems/invalid-idempotency-key');
  });
});

describe('GET /lancamentos', () => {
  it('filtro com data inexistente devolve 400', async () => {
    const res = await request(app).get('/lancamentos?data=2026-02-30').set(auth);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('rota inexistente', () => {
  it('devolve 404 problem+json', async () => {
    const res = await request(app).get('/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not-found');
  });
});
