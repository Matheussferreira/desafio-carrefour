import path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Express } from 'express';

export const ARQUIVO_SPEC = path.resolve(__dirname, '../../openapi.yaml');

type Documento = {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: object }> }> }>>;
};

/** Valida o documento como OpenAPI 3 e devolve a versão com todos os $ref resolvidos. */
export async function carregarSpec(): Promise<Documento> {
  await SwaggerParser.validate(ARQUIVO_SPEC);
  return (await SwaggerParser.dereference(ARQUIVO_SPEC)) as unknown as Documento;
}

interface CamadaExpress {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: CamadaExpress[] };
  regexp?: RegExp;
}

function prefixoDoMontagem(camada: CamadaExpress): string {
  // app.use('/lancamentos', router) vira /^\/lancamentos\/?(?=\/|$)/i
  const fonte = camada.regexp?.source ?? '';
  return fonte.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
}

function coletar(pilha: CamadaExpress[], prefixo: string, saida: Set<string>): void {
  for (const camada of pilha) {
    if (camada.route) {
      const caminho = (prefixo + camada.route.path).replace(/\/$/, '') || '/';
      for (const metodo of Object.keys(camada.route.methods)) {
        saida.add(`${metodo.toUpperCase()} ${caminho.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
      }
    } else if (camada.name === 'router' && camada.handle?.stack) {
      coletar(camada.handle.stack, prefixo + prefixoDoMontagem(camada), saida);
    }
  }
}

/** Todas as rotas registradas no app, no formato "GET /consolidado/{data}". */
export function rotasDoExpress(app: Express): Set<string> {
  const saida = new Set<string>();
  const pilha = (app as unknown as { _router: { stack: CamadaExpress[] } })._router.stack;
  coletar(pilha, '', saida);
  return saida;
}

export function rotasDaSpec(spec: Documento): Set<string> {
  const saida = new Set<string>();
  for (const [caminho, operacoes] of Object.entries(spec.paths)) {
    for (const metodo of Object.keys(operacoes)) saida.add(`${metodo.toUpperCase()} ${caminho}`);
  }
  return saida;
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

/** Confere um corpo de resposta contra o schema declarado na spec. Devolve a lista de erros (vazia = confere). */
export function errosDoContrato(
  spec: Documento,
  caminho: string,
  metodo: string,
  status: number,
  tipoDeConteudo: string,
  corpo: unknown,
): string[] {
  const resposta = spec.paths[caminho]?.[metodo.toLowerCase()]?.responses[String(status)];
  if (!resposta) return [`a spec não declara ${metodo} ${caminho} com status ${status}`];
  const schema = resposta.content?.[tipoDeConteudo]?.schema;
  if (!schema) return [`a spec não declara ${tipoDeConteudo} para ${metodo} ${caminho} ${status}`];
  const validar = ajv.compile(schema);
  return validar(corpo) ? [] : (validar.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`);
}
