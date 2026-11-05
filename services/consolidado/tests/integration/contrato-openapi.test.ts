/**
 * Confere respostas reais da API (Postgres, RabbitMQ e Redis reais) contra os schemas do openapi.yaml.
 */
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { IdpDeTeste } from '../helpers/idp';
import { carregarSpec, errosDoContrato } from '../helpers/openapi';
import { encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEAguardar } from './helpers';

const idp = new IdpDeTeste();
const LOJA = 'loja-contrato';
let auth: { Authorization: string };
let spec: Awaited<ReturnType<typeof carregarSpec>>;
let infra: Infra;

const confere = (caminho: string, res: request.Response) =>
  errosDoContrato(spec, caminho, 'get', res.status, (res.headers['content-type'] ?? '').split(';')[0], res.body);

beforeAll(async () => {
  spec = await carregarSpec();
  await idp.iniciar();
  auth = await idp.cabecalho({ comerciante: LOJA });
  infra = await iniciarInfra();
  await publicarEAguardar(infra.pubCh, montarEvento(uuidv4(), '2031-01-10', '100.00', 'credito', { comercianteId: LOJA }), LOJA);
  await publicarEAguardar(infra.pubCh, montarEvento(uuidv4(), '2031-01-12', '30.00', 'debito', { comercianteId: LOJA }), LOJA);
}, 40_000);

afterAll(async () => {
  await idp.parar();
  await encerrarInfra(infra);
});

describe('respostas reais conferem com a spec', () => {
  it('saldo do dia, vindo do banco e depois do cache', async () => {
    const doBanco = await request(app).get('/consolidado/2031-01-10').set(auth);
    const doCache = await request(app).get('/consolidado/2031-01-10').set(auth);
    expect([doBanco.body.source, doCache.body.source]).toEqual(['database', 'cache']);
    expect(confere('/consolidado/{data}', doBanco)).toEqual([]);
    expect(confere('/consolidado/{data}', doCache)).toEqual([]);
  });

  it('dia sem movimento (zeros, ultimoEventoAplicadoEm nulo) e saldo acumulado', async () => {
    const vazio = await request(app)
      .get('/consolidado/2031-01-11')
      .set(await idp.cabecalho({ comerciante: 'loja-sem-nada' }));
    const dia = await request(app).get('/consolidado/2031-01-12').set(auth);
    expect(vazio.body.ultimoEventoAplicadoEm).toBeNull();
    expect(dia.body.saldoAcumulado).toBe('70.00');
    expect(confere('/consolidado/{data}', vazio)).toEqual([]);
    expect(confere('/consolidado/{data}', dia)).toEqual([]);
  });

  it('intervalo', async () => {
    const res = await request(app).get('/consolidado?inicio=2031-01-09&fim=2031-01-13').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.dias).toHaveLength(5);
    expect(confere('/consolidado', res)).toEqual([]);
  });

  it('erros: data inexistente, intervalo invertido e grande demais, sem token, sem escopo', async () => {
    const dataRuim = await request(app).get('/consolidado/2031-02-30').set(auth);
    const invertido = await request(app).get('/consolidado?inicio=2031-02-10&fim=2031-02-01').set(auth);
    const grande = await request(app).get('/consolidado?inicio=2031-01-01&fim=2031-12-31').set(auth);
    const semToken = await request(app).get('/consolidado/2031-01-10');
    const semEscopo = await request(app)
      .get('/consolidado/2031-01-10')
      .set(await idp.cabecalho({ comerciante: LOJA, escopos: ['outro.escopo'] }));

    expect([dataRuim.status, invertido.status, grande.status, semToken.status, semEscopo.status]).toEqual([400, 400, 400, 401, 403]);
    expect(confere('/consolidado/{data}', dataRuim)).toEqual([]);
    expect(confere('/consolidado', invertido)).toEqual([]);
    expect(confere('/consolidado', grande)).toEqual([]);
    expect(confere('/consolidado/{data}', semToken)).toEqual([]);
    expect(confere('/consolidado/{data}', semEscopo)).toEqual([]);
  });

  it('/health e /ready', async () => {
    const health = await request(app).get('/health');
    const ready = await request(app).get('/ready');
    expect(confere('/health', health)).toEqual([]);
    expect(ready.status).toBe(200);
    expect(confere('/ready', ready)).toEqual([]);
  });
});
