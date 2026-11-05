import fs from 'fs';
import path from 'path';
import app from '../../src/app';
import { carregarSpec, rotasDaSpec, rotasDoExpress } from '../helpers/openapi';

describe('openapi.yaml do lançamentos', () => {
  it('é um documento OpenAPI 3 válido', async () => {
    const spec = await carregarSpec();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('declara exatamente as rotas que o Express registra', async () => {
    const spec = await carregarSpec();
    const naSpec = rotasDaSpec(spec);
    const noCodigo = rotasDoExpress(app);

    expect([...noCodigo].filter(r => !naSpec.has(r)).sort()).toEqual([]); // rota sem documentação
    expect([...naSpec].filter(r => !noCodigo.has(r)).sort()).toEqual([]); // documentação sem rota
    expect(noCodigo.size).toBeGreaterThanOrEqual(5);
  });

  it('os escopos da spec são os que o código exige', async () => {
    const fonte = fs.readFileSync(path.resolve(__dirname, '../../src/routes/lancamentos.ts'), 'utf8');
    const yaml = fs.readFileSync(path.resolve(__dirname, '../../openapi.yaml'), 'utf8');
    const escoposDaSpec = [...yaml.matchAll(/bearer: \[([\w.]+)\]/g)].map(m => m[1]);
    const escoposDoCodigo = [...fonte.matchAll(/exigirEscopo\('([\w.]+)'\)/g)].map(m => m[1]);
    expect(escoposDaSpec.sort()).toEqual(escoposDoCodigo.sort());
  });
});
