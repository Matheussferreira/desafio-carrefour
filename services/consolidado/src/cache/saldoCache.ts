import { config } from '../config';
import { getRedis } from '../redis';

// Chaves, todas por comerciante:
//   saldo:ver:{comerciante}                 contador de versão, incrementado a cada evento aplicado
//   saldo:epoca                             contador global, incrementado quando o cliente Redis reconecta
//   saldo:e{epoca}:{comerciante}:v{versao}:{data}   resposta do dia (JSON), com TTL
//   saldo:ultimo:{comerciante}              ultimoEventoAplicadoEm
// O identificador do comerciante não admite dois-pontos, então as chaves não colidem.
//
// Por que versão na chave: apagar chaves depois de um evento deixa uma janela em que uma leitura
// lenta, que consultou o banco antes do commit, grava o valor antigo depois da invalidação. Com a
// versão na chave isso deixa de importar: o leitor grava sob a versão que leu ANTES de consultar o
// banco, e o consumidor incrementa a versão DEPOIS do commit. Uma gravação atrasada cai numa chave
// de versão velha, que nenhuma leitura nova usa, e expira sozinha pelo TTL.
//
// Por que época na chave: com o Redis fora, o consumidor aplica eventos mas não consegue avançar a
// versão, e uma entrada gravada antes da queda continuaria válida depois da volta (até o TTL). A
// época é global e sobe na reconexão do cliente, o que invalida de uma vez todo o cache anterior.

export interface ReferenciaCache {
  epoca: string;
  versao: string;
}

export const chaveVersao = (comercianteId: string): string => `saldo:ver:${comercianteId}`;
export const chaveEpoca = 'saldo:epoca';
export const chaveSaldo = (comercianteId: string, ref: ReferenciaCache, data: string): string =>
  `saldo:e${ref.epoca}:${comercianteId}:v${ref.versao}:${data}`;
export const chaveUltimoEventoAplicadoEm = (comercianteId: string): string => `saldo:ultimo:${comercianteId}`;

/**
 * Versão atual do cache do comerciante. Se o contador não existe (Redis novo, flush ou eviction),
 * ele nasce com o relógio em milissegundos. Assim uma versão nova nunca coincide com uma anterior,
 * mesmo que chaves antigas ainda estejam no Redis.
 */
export async function versaoAtual(comercianteId: string): Promise<string> {
  const redis = getRedis();
  const chave = chaveVersao(comercianteId);
  const atual = await redis.get(chave);
  if (atual !== null) return atual;
  await redis.set(chave, String(Date.now()), 'NX');
  return (await redis.get(chave)) ?? '0';
}

/** Época atual do cache. Se o contador não existe (Redis novo), nasce com o relógio, como a versão. */
export async function epocaAtual(): Promise<string> {
  const redis = getRedis();
  const atual = await redis.get(chaveEpoca);
  if (atual !== null) return atual;
  await redis.set(chaveEpoca, String(Date.now()), 'NX');
  return (await redis.get(chaveEpoca)) ?? '0';
}

/** Chamado na reconexão do Redis: todo o cache anterior deixa de ser lido. */
export async function avancarEpoca(): Promise<string> {
  const resultados = await getRedis().multi().set(chaveEpoca, String(Date.now()), 'NX').incr(chaveEpoca).exec();
  return String(resultados?.[1]?.[1] ?? '');
}

/** Época e versão lidas juntas, antes de consultar o banco. */
export async function referenciaAtual(comercianteId: string): Promise<ReferenciaCache> {
  const [epoca, versao] = await Promise.all([epocaAtual(), versaoAtual(comercianteId)]);
  return { epoca, versao };
}

/** Chamado pelo consumidor depois do commit: invalida todo o cache do comerciante de uma vez. */
export async function avancarVersao(comercianteId: string): Promise<string> {
  const resultados = await getRedis()
    .multi()
    .set(chaveVersao(comercianteId), String(Date.now()), 'NX')
    .incr(chaveVersao(comercianteId))
    .exec();
  return String(resultados?.[1]?.[1] ?? '');
}

export async function lerSaldo<T>(comercianteId: string, ref: ReferenciaCache, data: string): Promise<T | null> {
  const bruto = await getRedis().get(chaveSaldo(comercianteId, ref, data));
  return bruto ? (JSON.parse(bruto) as T) : null;
}

export async function gravarSaldo(comercianteId: string, ref: ReferenciaCache, data: string, valor: object): Promise<void> {
  await getRedis().setex(chaveSaldo(comercianteId, ref, data), config.cacheTtlSeconds, JSON.stringify(valor));
}

export async function lerUltimoEventoAplicadoEm(comercianteId: string): Promise<string | null> {
  return getRedis().get(chaveUltimoEventoAplicadoEm(comercianteId));
}

export async function gravarUltimoEventoAplicadoEm(comercianteId: string, instanteIso: string): Promise<void> {
  await getRedis().set(chaveUltimoEventoAplicadoEm(comercianteId), instanteIso);
}
