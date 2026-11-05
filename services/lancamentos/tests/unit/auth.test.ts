import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';
import { config } from '../../src/config';
import { COMERCIANTE_PADRAO, isComercianteId } from '../../src/domain/comerciante';

const corpo = { valor: '10.00', tipo: 'credito', data: '2026-06-15' };

describe('isComercianteId', () => {
  it.each(['padrao', 'loja-1', 'Loja_2', 'a'.repeat(64)])('aceita %p', v => {
    expect(isComercianteId(v)).toBe(true);
  });

  it.each(['', 'a'.repeat(65), 'loja:1', 'loja 1', 'lo/ja', 42, null, undefined])('recusa %p', v => {
    expect(isComercianteId(v)).toBe(false);
  });
});

describe('POST /auth/login (desenvolvimento)', () => {
  it('sem corpo usa o comerciante padrão e coloca o claim no token', async () => {
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(200);
    expect(res.body.comerciante).toBe(COMERCIANTE_PADRAO);
    expect(jwt.verify(res.body.token, config.jwtSecret)).toMatchObject({ comerciante_id: COMERCIANTE_PADRAO });
  });

  it('aceita escolher o comerciante', async () => {
    const res = await request(app).post('/auth/login').send({ comerciante: 'loja-9' });
    expect(jwt.verify(res.body.token, config.jwtSecret)).toMatchObject({ comerciante_id: 'loja-9' });
  });

  it('recusa identificador inválido com 400', async () => {
    const res = await request(app).post('/auth/login').send({ comerciante: 'a:b' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('authMiddleware', () => {
  it('sem token: 401', async () => {
    const res = await request(app).post('/lancamentos').send(corpo);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('token assinado com outro segredo: 401', async () => {
    const falso = jwt.sign({ comerciante_id: 'loja-1' }, 'outro-segredo');
    const res = await request(app).post('/lancamentos').set('Authorization', `Bearer ${falso}`).send(corpo);
    expect(res.status).toBe(401);
  });

  it('token válido sem o claim de comerciante: 403', async () => {
    const semClaim = jwt.sign({ sub: 'alguem' }, config.jwtSecret);
    const res = await request(app).post('/lancamentos').set('Authorization', `Bearer ${semClaim}`).send(corpo);
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/merchant-claim-missing');
  });

  it('token com claim de comerciante inválido: 403', async () => {
    const ruim = jwt.sign({ comerciante_id: 'a:b' }, config.jwtSecret);
    const res = await request(app).post('/lancamentos').set('Authorization', `Bearer ${ruim}`).send(corpo);
    expect(res.status).toBe(403);
  });
});
