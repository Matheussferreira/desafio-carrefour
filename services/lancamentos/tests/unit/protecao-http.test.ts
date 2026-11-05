import request from 'supertest';
import app from '../../src/app';
import { IdpDeTeste } from '../helpers/idp';

const idp = new IdpDeTeste();
let auth: { Authorization: string };

beforeAll(async () => {
  await idp.iniciar();
  auth = await idp.cabecalho();
});

afterAll(async () => {
  await idp.parar();
});

describe('proteções HTTP', () => {
  it('corpo acima do limite responde 413 problem+json', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .set(auth)
      .send({ valor: '10.00', tipo: 'credito', data: '2026-06-15', descricao: 'x'.repeat(20 * 1024) });

    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ type: '/problems/payload-too-large', status: 413 });
  });

  it('corpo grande demais é recusado antes da autenticação', async () => {
    const res = await request(app)
      .post('/lancamentos')
      .send({ lixo: 'x'.repeat(20 * 1024) });

    expect(res.status).toBe(413);
  });

  it('envia cabeçalhos de segurança e não revela o framework', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});
