import request from 'supertest';
import app from '../../src/app';
import { IdpDeTeste } from '../helpers/idp';
import { chaveSaldo, chaveUltimoEventoAplicadoEm, chaveVersao } from '../../src/cache/saldoCache';
import { config } from '../../src/config';
import { diasNoIntervalo } from '../../src/domain/data';

const idp = new IdpDeTeste();
let auth: { Authorization: string };

beforeAll(async () => {
  await idp.iniciar();
  auth = await idp.cabecalho({ comerciante: 'loja-a' });
});

afterAll(async () => {
  await idp.parar();
});

describe('diasNoIntervalo', () => {
  it('conta as duas pontas', () => {
    expect(diasNoIntervalo('2026-06-15', '2026-06-15')).toBe(1);
    expect(diasNoIntervalo('2026-06-15', '2026-06-17')).toBe(3);
  });

  it('atravessa mês, ano e dia bissexto', () => {
    expect(diasNoIntervalo('2026-12-30', '2027-01-02')).toBe(4);
    expect(diasNoIntervalo('2028-02-28', '2028-03-01')).toBe(3);
    expect(diasNoIntervalo('2026-02-28', '2026-03-01')).toBe(2);
  });

  it('não sofre com mudança de horário de verão', () => {
    expect(diasNoIntervalo('2026-03-01', '2026-11-30')).toBe(275);
  });
});

describe('chaves de cache', () => {
  it('são separadas por comerciante e carregam a versão', () => {
    expect(chaveSaldo('loja-a', '7', '2026-06-15')).toBe('saldo:loja-a:v7:2026-06-15');
    expect(chaveSaldo('loja-b', '7', '2026-06-15')).not.toBe(chaveSaldo('loja-a', '7', '2026-06-15'));
    expect(chaveVersao('loja-a')).toBe('saldo:ver:loja-a');
    expect(chaveUltimoEventoAplicadoEm('loja-a')).toBe('saldo:ultimo:loja-a');
  });

  it('versões diferentes geram chaves diferentes para a mesma data', () => {
    expect(chaveSaldo('loja-a', '7', '2026-06-15')).not.toBe(chaveSaldo('loja-a', '8', '2026-06-15'));
  });
});

describe('GET /consolidado (intervalo): validação sem tocar no banco', () => {
  const get = (qs: string) => request(app).get(`/consolidado${qs}`).set(auth);

  it.each([
    ['sem parâmetros', ''],
    ['só inicio', '?inicio=2026-06-01'],
    ['data inexistente', '?inicio=2026-02-30&fim=2026-03-05'],
    ['formato errado', '?inicio=01/06/2026&fim=05/06/2026'],
    ['inicio depois de fim', '?inicio=2026-06-10&fim=2026-06-01'],
  ])('%s: 400 problem+json', async (_nome, qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('acima do limite de dias: 400 com o máximo no corpo', async () => {
    const res = await get('?inicio=2026-01-01&fim=2026-12-31');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ type: '/problems/interval-too-large', maxDias: config.maxDiasIntervalo });
  });
});
