import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';
import { config } from '../../src/config';

const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'teste', comerciante_id: 'loja-a' }, config.jwtSecret)}` };

describe('GET /consolidado/:data: data inválida é 400 problem+json, sem tocar no banco', () => {
  it.each(['2026-02-30', '2026-13-01', 'hoje', '2026-6-1'])('data %p', async data => {
    const res = await request(app).get(`/consolidado/${data}`).set(auth);

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ type: '/problems/validation-error', status: 400 });
  });

  it('exige token', async () => {
    const res = await request(app).get('/consolidado/2026-06-15');
    expect(res.status).toBe(401);
  });
});

describe('/ready', () => {
  it('fica vermelho quando as dependências não estão conectadas', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not ready');
  });

  it('/health responde sempre', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
