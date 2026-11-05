/**
 * Saldo por comerciante: isolamento, dia sem movimento, acumulado com lançamento retroativo,
 * ultimoEventoAplicadoEm, evento antigo (1.0) e consulta por intervalo.
 * Cada teste usa comerciantes próprios para não depender da ordem de execução.
 */
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { chaveSaldo, gravarSaldo, versaoAtual } from '../../src/cache/saldoCache';
import { consultarDia } from '../../src/domain/saldoQueries';
import { config } from '../../src/config';
import { IdpDeTeste } from '../helpers/idp';
import { pool } from '../../src/db';
import { getRedis } from '../../src/redis';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEAguardar } from './helpers';

const idp = new IdpDeTeste();
const COMERCIANTES = [
  'padrao', 'loja-a', 'loja-b', 'loja-vazia', 'loja-c', 'loja-d', 'loja-e', 'loja-f', 'loja-g', 'loja-race', 'loja-race2',
];
const cabecalhos = new Map<string, { Authorization: string }>();
const tokenDe = (c: string): { Authorization: string } => cabecalhos.get(c) as { Authorization: string };
const consultar = (comerciante: string, data: string) =>
  request(app).get(`/consolidado/${data}`).set(tokenDe(comerciante));

describe('Saldo por comerciante', () => {
  let infra: Infra;

  async function aplicar(
    comercianteId: string | null,
    data: string,
    valor: string,
    tipo: 'credito' | 'debito' = 'credito',
    createdAt?: string,
  ): Promise<void> {
    const e = montarEvento(uuidv4(), data, valor, tipo, { comercianteId, createdAt });
    await publicarEAguardar(infra.pubCh, e, comercianteId ?? 'padrao');
  }

  beforeAll(async () => {
    await idp.iniciar();
    for (const c of COMERCIANTES) cabecalhos.set(c, await idp.cabecalho({ comerciante: c }));
    infra = await iniciarInfra();
    await getRedis().flushdb();
  }, 40_000);

  afterAll(async () => {
    await idp.parar();
    await encerrarInfra(infra);
  });

  it('isola os comerciantes: o mesmo dia tem saldos independentes, também no cache', async () => {
    await aplicar('loja-a', '2030-01-10', '100.00');
    await aplicar('loja-b', '2030-01-10', '7.00');

    const a = await consultar('loja-a', '2030-01-10');
    const b = await consultar('loja-b', '2030-01-10');
    expect(a.body).toMatchObject({ comercianteId: 'loja-a', totalCreditos: '100.00', saldoAcumulado: '100.00' });
    expect(b.body).toMatchObject({ comercianteId: 'loja-b', totalCreditos: '7.00', saldoAcumulado: '7.00' });

    // Agora ambos estão em cache; cada um continua vendo apenas o seu
    const a2 = await consultar('loja-a', '2030-01-10');
    const b2 = await consultar('loja-b', '2030-01-10');
    expect([a2.body.source, b2.body.source]).toEqual(['cache', 'cache']);
    expect(a2.body.totalCreditos).toBe('100.00');
    expect(b2.body.totalCreditos).toBe('7.00');

    // Evento de uma loja não invalida o cache da outra
    await aplicar('loja-a', '2030-01-10', '1.00');
    expect((await consultar('loja-b', '2030-01-10')).body).toMatchObject({ source: 'cache', totalCreditos: '7.00' });
    expect((await consultar('loja-a', '2030-01-10')).body).toMatchObject({ source: 'database', totalCreditos: '101.00' });
  }, 30_000);

  it('dia sem movimento devolve 200 com zeros, não 404', async () => {
    const res = await consultar('loja-vazia', '2030-02-02');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      comercianteId: 'loja-vazia',
      data: '2030-02-02',
      totalCreditos: '0.00',
      totalDebitos: '0.00',
      resultadoDia: '0.00',
      saldoAcumulado: '0.00',
      ultimoEventoAplicadoEm: null,
    });
  });

  it('dia sem movimento no meio do histórico traz zeros no dia e o acumulado vigente', async () => {
    await aplicar('loja-c', '2030-03-01', '100.00');
    await aplicar('loja-c', '2030-03-03', '80.00');
    await aplicar('loja-c', '2030-03-03', '30.00', 'debito');

    expect((await consultar('loja-c', '2030-03-02')).body).toMatchObject({
      totalCreditos: '0.00',
      totalDebitos: '0.00',
      resultadoDia: '0.00',
      saldoAcumulado: '100.00',
    });
    expect((await consultar('loja-c', '2030-03-03')).body).toMatchObject({
      totalCreditos: '80.00',
      totalDebitos: '30.00',
      resultadoDia: '50.00',
      saldoAcumulado: '150.00',
    });
    expect((await consultar('loja-c', '2030-03-10')).body).toMatchObject({
      resultadoDia: '0.00',
      saldoAcumulado: '150.00',
    });
    // antes de qualquer movimento o acumulado é zero
    expect((await consultar('loja-c', '2030-02-28')).body.saldoAcumulado).toBe('0.00');
  }, 30_000);

  it('lançamento retroativo corrige o acumulado das datas seguintes e nunca serve valor antigo', async () => {
    await aplicar('loja-d', '2030-04-10', '100.00');
    await aplicar('loja-d', '2030-04-12', '50.00');

    // Coloca em cache uma data anterior, a própria data e uma posterior
    for (const d of ['2030-04-05', '2030-04-10', '2030-04-12']) await consultar('loja-d', d);
    expect((await consultar('loja-d', '2030-04-12')).body).toMatchObject({ source: 'cache', saldoAcumulado: '150.00' });
    expect((await consultar('loja-d', '2030-04-10')).body.source).toBe('cache');

    // Lançamento retroativo no dia 10
    await aplicar('loja-d', '2030-04-10', '10.00');

    // O cache do comerciante inteiro mudou de versão: tudo é relido do banco
    const d12 = await consultar('loja-d', '2030-04-12');
    expect(d12.body).toMatchObject({ source: 'database', resultadoDia: '50.00', saldoAcumulado: '160.00' });
    expect((await consultar('loja-d', '2030-04-10')).body).toMatchObject({
      source: 'database',
      resultadoDia: '110.00',
      saldoAcumulado: '110.00',
    });
    expect((await consultar('loja-d', '2030-04-05')).body).toMatchObject({ source: 'database', saldoAcumulado: '0.00' });
  }, 30_000);

  describe('corrida entre leitura lenta e evento', () => {
    it('gravação atrasada de valor antigo cai numa versão velha e nunca é servida', async () => {
      const dia = '2030-08-15';
      await aplicar('loja-race', dia, '100.00');

      // Leitor lento: lê a versão, consulta o banco (100.00) e ainda não gravou no cache
      const versaoDoLeitor = await versaoAtual('loja-race');
      const valorAntigo = await consultarDia(pool, 'loja-race', dia);
      expect(valorAntigo.saldoAcumulado).toBe('100.00');

      // Enquanto isso, um evento é aplicado e invalida o cache do comerciante
      await aplicar('loja-race', dia, '50.00');
      expect(await versaoAtual('loja-race')).not.toBe(versaoDoLeitor);

      // A gravação atrasada do leitor lento acontece só agora, depois da invalidação
      await gravarSaldo('loja-race', versaoDoLeitor, dia, valorAntigo);
      expect(await getRedis().get(chaveSaldo('loja-race', versaoDoLeitor, dia))).not.toBeNull(); // está lá, mas...

      // ...nenhuma leitura nova a enxerga
      const res = await consultar('loja-race', dia);
      expect(res.body).toMatchObject({ source: 'database', totalCreditos: '150.00', saldoAcumulado: '150.00' });
      expect((await consultar('loja-race', dia)).body).toMatchObject({ source: 'cache', totalCreditos: '150.00' });
    }, 30_000);

    it('o mesmo cenário repetido com leituras concorrentes ao evento nunca devolve o total antigo depois dele', async () => {
      const dia = '2030-09-01';
      await aplicar('loja-race2', dia, '10.00');

      const leituras: Array<{ totalCreditos: string }> = [];
      let aplicado = false;
      const leitor = (async () => {
        while (!aplicado) leituras.push((await consultar('loja-race2', dia)).body);
      })();
      await aplicar('loja-race2', dia, '5.00');
      aplicado = true;
      await leitor;

      // Depois que o evento foi processado, toda leitura nova vê o total novo
      for (let i = 0; i < 5; i++) {
        expect((await consultar('loja-race2', dia)).body.totalCreditos).toBe('15.00');
      }
    }, 30_000);
  });

  it('evento 1.0, sem comercianteId, entra no comerciante padrão', async () => {
    await aplicar(null, '2030-05-05', '42.00');

    const res = await consultar('padrao', '2030-05-05');
    expect(res.body).toMatchObject({ comercianteId: 'padrao', totalCreditos: '42.00' });
  });

  it('ultimoEventoAplicadoEm é o maior instante de lançamento aplicado, mesmo com eventos fora de ordem', async () => {
    const t1 = '2030-06-01T10:00:00.000Z';
    const t2 = '2030-06-01T12:30:00.000Z';
    await aplicar('loja-e', '2030-06-01', '1.00', 'credito', t2);
    await aplicar('loja-e', '2030-06-01', '1.00', 'credito', t1); // chegou depois, mas é mais antigo

    const res = await consultar('loja-e', '2030-06-01');
    expect(res.body.ultimoEventoAplicadoEm).toBe(t2);
  }, 20_000);

  describe('consulta por intervalo', () => {
    const intervalo = (comerciante: string, inicio: string, fim: string) =>
      request(app).get(`/consolidado?inicio=${inicio}&fim=${fim}`).set(tokenDe(comerciante));

    it('traz um item por dia, inclusive vazios, com o acumulado correndo', async () => {
      await aplicar('loja-f', '2030-07-01', '100.00');
      await aplicar('loja-f', '2030-07-03', '30.00', 'debito');
      await aplicar('loja-f', '2030-06-20', '10.00'); // antes do intervalo: entra só no acumulado inicial

      const res = await intervalo('loja-f', '2030-06-30', '2030-07-04');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ comercianteId: 'loja-f', inicio: '2030-06-30', fim: '2030-07-04' });
      expect(res.body.ultimoEventoAplicadoEm).not.toBeNull();
      expect(
        res.body.dias.map((d: { data: string; resultadoDia: string; saldoAcumulado: string }) => [
          d.data,
          d.resultadoDia,
          d.saldoAcumulado,
        ]),
      ).toEqual([
        ['2030-06-30', '0.00', '10.00'],
        ['2030-07-01', '100.00', '110.00'],
        ['2030-07-02', '0.00', '110.00'],
        ['2030-07-03', '-30.00', '80.00'],
        ['2030-07-04', '0.00', '80.00'],
      ]);
    });

    it('o acumulado do intervalo bate com a consulta de um dia', async () => {
      const dia = await consultar('loja-f', '2030-07-03');
      const lote = await intervalo('loja-f', '2030-07-03', '2030-07-03');
      expect(lote.body.dias[0].saldoAcumulado).toBe(dia.body.saldoAcumulado);
    });

    it('não mistura comerciantes', async () => {
      const res = await intervalo('loja-g', '2030-07-01', '2030-07-03');
      expect(res.body.dias.every((d: { saldoAcumulado: string }) => d.saldoAcumulado === '0.00')).toBe(true);
    });

    it('respeita o limite de dias', async () => {
      const dentro = await intervalo('loja-g', '2030-01-01', '2030-04-02'); // 92 dias
      const fora = await intervalo('loja-g', '2030-01-01', '2030-04-03'); // 93 dias
      expect(dentro.status).toBe(200);
      expect(dentro.body.dias).toHaveLength(config.maxDiasIntervalo);
      expect(fora.status).toBe(400);
      expect(fora.body.type).toBe('/problems/interval-too-large');
    });
  });
});
