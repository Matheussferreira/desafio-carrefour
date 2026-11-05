import express from 'express';
import request from 'supertest';
import { criarRateLimiter, limitePorMinuto } from '../../src/middleware/rateLimit';

describe('rate limit do consolidado', () => {
  it('usa 6000 por minuto sem configuração e ignora valores inválidos', () => {
    expect(limitePorMinuto(undefined)).toBe(6000);
    expect(limitePorMinuto('')).toBe(6000);
    expect(limitePorMinuto('abc')).toBe(6000);
    expect(limitePorMinuto('-5')).toBe(6000);
    expect(limitePorMinuto('0')).toBe(6000);
    expect(limitePorMinuto('2.5')).toBe(6000);
  });

  it('aceita um limite menor por variável de ambiente', () => {
    expect(limitePorMinuto('300')).toBe(300);
  });

  it('acima do limite responde 429 com Retry-After, antes disso 200', async () => {
    const app = express();
    app.use(criarRateLimiter(3));
    app.get('/x', (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/x')).status).toBe(200);
    }
    const bloqueada = await request(app).get('/x');
    expect(bloqueada.status).toBe(429);
    expect(Number(bloqueada.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(bloqueada.headers['retry-after'])).toBeLessThanOrEqual(60);
  });
});
