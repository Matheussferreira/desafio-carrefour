import request from 'supertest';
import app from '../../src/app';
import { register } from '../../src/metrics';
import { IdpDeTeste } from '../helpers/idp';

const idp = new IdpDeTeste();

beforeAll(async () => {
  await idp.iniciar();
});

afterAll(async () => {
  await idp.parar();
});

async function contagem(rota: string, status: string): Promise<number> {
  const metrica = await register.getSingleMetricAsString('lancamentos_http_requests_total');
  const linha = metrica
    .split('\n')
    .find(l => l.includes(`route="${rota}"`) && l.includes(`status="${status}"`));
  return linha ? Number(linha.split(' ').pop()) : 0;
}

describe('métricas HTTP', () => {
  it('conta a requisição com o padrão da rota e o status', async () => {
    const antes = await contagem('/lancamentos', '400');
    await request(app)
      .post('/lancamentos')
      .set(await idp.cabecalho())
      .send({ valor: '10.00', tipo: 'credito', data: '2026-02-30' });
    expect(await contagem('/lancamentos', '400')).toBe(antes + 1);
  });

  it('conta o 401 de quem não se autenticou', async () => {
    const antes = await contagem('/lancamentos', '401');
    await request(app).post('/lancamentos').send({});
    expect(await contagem('/lancamentos', '401')).toBe(antes + 1);
  });

  it('alimenta o histograma de latência', async () => {
    await request(app).get('/health');
    const texto = await register.getSingleMetricAsString('lancamentos_http_request_duration_seconds');
    expect(texto).toMatch(/lancamentos_http_request_duration_seconds_count\{[^}]*route="\/health"/);
  });

  it('não mede o próprio /metrics', async () => {
    await request(app).get('/metrics');
    const texto = await register.getSingleMetricAsString('lancamentos_http_requests_total');
    expect(texto).not.toContain('route="/metrics"');
  });
});
