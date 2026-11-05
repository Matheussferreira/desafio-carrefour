import fs from 'fs';
import path from 'path';
import app from '../../src/app';
import { carregarSpec, rotasDaSpec, rotasDoExpress } from '../helpers/openapi';

describe('openapi.yaml do consolidado', () => {
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

  it('o escopo da spec é o que o app exige para /consolidado', async () => {
    const fonte = fs.readFileSync(path.resolve(__dirname, '../../src/app.ts'), 'utf8');
    const yaml = fs.readFileSync(path.resolve(__dirname, '../../openapi.yaml'), 'utf8');
    const escopoDoCodigo = /exigirEscopo\('([\w.]+)'\)/.exec(fonte)?.[1];
    const escoposDaSpec = new Set([...yaml.matchAll(/bearer: \[([\w.]+)\]/g)].map(m => m[1]));
    expect([...escoposDaSpec]).toEqual([escopoDoCodigo]);
  });
});
