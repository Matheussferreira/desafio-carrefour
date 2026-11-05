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
  const metrica = await register.getSingleMetricAsString('consolidado_http_requests_total');
  const linha = metrica
    .split('\n')
    .find(l => l.includes(`route="${rota}"`) && l.includes(`status="${status}"`));
  return linha ? Number(linha.split(' ').pop()) : 0;
}

describe('métricas HTTP', () => {
  it('usa o padrão da rota, e não a data da URL, como rótulo', async () => {
    const antes = await contagem('/consolidado/:data', '400');
    await request(app).get('/consolidado/2026-02-30').set(await idp.cabecalho());
    expect(await contagem('/consolidado/:data', '400')).toBe(antes + 1);
    const texto = await register.getSingleMetricAsString('consolidado_http_requests_total');
    expect(texto).not.toContain('2026-02-30');
  });

  it('conta o 401 de quem não se autenticou', async () => {
    const antes = await contagem('/consolidado', '401');
    await request(app).get('/consolidado/2026-06-15');
    expect(await contagem('/consolidado', '401')).toBe(antes + 1);
  });

  it('alimenta o histograma de latência', async () => {
    await request(app).get('/health');
    const texto = await register.getSingleMetricAsString('consolidado_http_request_duration_seconds');
    expect(texto).toMatch(/consolidado_http_request_duration_seconds_count\{[^}]*route="\/health"/);
  });
});
