/**
 * Saldo por comerciante: isolamento, dia sem movimento, acumulado com lançamento retroativo,
 * atualizadoAte, evento antigo (1.0) e consulta por intervalo.
 * Cada teste usa comerciantes próprios para não depender da ordem de execução.
 */
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../../src/app';
import { chaveSaldo } from '../../src/cache/saldoCache';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { getRedis } from '../../src/redis';
import { aguardar, encerrarInfra, iniciarInfra, Infra, montarEvento, publicarEvento } from './helpers';

const tokenDe = (c: string) => ({
  Authorization: `Bearer ${jwt.sign({ sub: 'teste', comerciante_id: c }, config.jwtSecret)}`,
});
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
    publicarEvento(infra.pubCh, e);
    await aguardar(async () => {
      const { rows } = await pool.query('SELECT 1 FROM eventos_processados WHERE evento_id = $1', [e.eventoId]);
      return rows.length === 1;
    }, 10_000);
  }

  beforeAll(async () => {
    infra = await iniciarInfra();
    await getRedis().flushdb();
  }, 40_000);

  afterAll(async () => {
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
    expect(await getRedis().get(chaveSaldo('loja-b', '2030-01-10'))).not.toBeNull();
    expect(await getRedis().get(chaveSaldo('loja-a', '2030-01-10'))).toBeNull();
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
      atualizadoAte: null,
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

  it('lançamento retroativo corrige o acumulado e invalida a data e as posteriores, não as anteriores', async () => {
    await aplicar('loja-d', '2030-04-10', '100.00');
    await aplicar('loja-d', '2030-04-12', '50.00');

    // Põe em cache uma data anterior, a própria data e uma posterior
    for (const d of ['2030-04-05', '2030-04-10', '2030-04-12']) await consultar('loja-d', d);
    for (const d of ['2030-04-05', '2030-04-10', '2030-04-12']) {
      expect(await getRedis().get(chaveSaldo('loja-d', d))).not.toBeNull();
    }
    expect((await consultar('loja-d', '2030-04-12')).body).toMatchObject({ source: 'cache', saldoAcumulado: '150.00' });

    // Lançamento retroativo no dia 10
    await aplicar('loja-d', '2030-04-10', '10.00');

    expect(await getRedis().get(chaveSaldo('loja-d', '2030-04-10'))).toBeNull();
    expect(await getRedis().get(chaveSaldo('loja-d', '2030-04-12'))).toBeNull();
    expect(await getRedis().get(chaveSaldo('loja-d', '2030-04-05'))).not.toBeNull(); // anterior, intacta

    const d12 = await consultar('loja-d', '2030-04-12');
    expect(d12.body).toMatchObject({ source: 'database', resultadoDia: '50.00', saldoAcumulado: '160.00' });
    expect((await consultar('loja-d', '2030-04-10')).body).toMatchObject({
      resultadoDia: '110.00',
      saldoAcumulado: '110.00',
    });
    expect((await consultar('loja-d', '2030-04-05')).body).toMatchObject({ source: 'cache', saldoAcumulado: '0.00' });
  }, 30_000);

  it('evento 1.0, sem comercianteId, entra no comerciante padrão', async () => {
    await aplicar(null, '2030-05-05', '42.00');

    const res = await consultar('padrao', '2030-05-05');
    expect(res.body).toMatchObject({ comercianteId: 'padrao', totalCreditos: '42.00' });
  });

  it('atualizadoAte é o maior instante de lançamento aplicado, mesmo com eventos fora de ordem', async () => {
    const t1 = '2030-06-01T10:00:00.000Z';
    const t2 = '2030-06-01T12:30:00.000Z';
    await aplicar('loja-e', '2030-06-01', '1.00', 'credito', t2);
    await aplicar('loja-e', '2030-06-01', '1.00', 'credito', t1); // chegou depois, mas é mais antigo

    const res = await consultar('loja-e', '2030-06-01');
    expect(res.body.atualizadoAte).toBe(t2);
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
      expect(res.body.atualizadoAte).not.toBeNull();
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
