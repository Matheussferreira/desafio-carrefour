import { config } from '../config';
import { getRedis } from '../redis';

// Chaves, todas por comerciante:
//   saldo:ver:{comerciante}                 contador de versão, incrementado a cada evento aplicado
//   saldo:{comerciante}:v{versao}:{data}    resposta do dia (JSON), com TTL
//   saldo:ultimo:{comerciante}              ultimoEventoAplicadoEm
// O identificador do comerciante não admite dois-pontos, então as chaves não colidem.
//
// Por que versão na chave: apagar chaves depois de um evento deixa uma janela em que uma leitura
// lenta, que consultou o banco antes do commit, grava o valor antigo depois da invalidação. Com a
// versão na chave isso deixa de importar: o leitor grava sob a versão que leu ANTES de consultar o
// banco, e o consumidor incrementa a versão DEPOIS do commit. Uma gravação atrasada cai numa chave
// de versão velha, que nenhuma leitura nova usa, e expira sozinha pelo TTL.

export const chaveVersao = (comercianteId: string): string => `saldo:ver:${comercianteId}`;
export const chaveSaldo = (comercianteId: string, versao: string, data: string): string =>
  `saldo:${comercianteId}:v${versao}:${data}`;
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

/** Chamado pelo consumidor depois do commit: invalida todo o cache do comerciante de uma vez. */
export async function avancarVersao(comercianteId: string): Promise<string> {
  const resultados = await getRedis()
    .multi()
    .set(chaveVersao(comercianteId), String(Date.now()), 'NX')
    .incr(chaveVersao(comercianteId))
    .exec();
  return String(resultados?.[1]?.[1] ?? '');
}

export async function lerSaldo<T>(comercianteId: string, versao: string, data: string): Promise<T | null> {
  const bruto = await getRedis().get(chaveSaldo(comercianteId, versao, data));
  return bruto ? (JSON.parse(bruto) as T) : null;
}

export async function gravarSaldo(comercianteId: string, versao: string, data: string, valor: object): Promise<void> {
  await getRedis().setex(chaveSaldo(comercianteId, versao, data), config.cacheTtlSeconds, JSON.stringify(valor));
}

export async function lerUltimoEventoAplicadoEm(comercianteId: string): Promise<string | null> {
  return getRedis().get(chaveUltimoEventoAplicadoEm(comercianteId));
}

export async function gravarUltimoEventoAplicadoEm(comercianteId: string, instanteIso: string): Promise<void> {
  await getRedis().set(chaveUltimoEventoAplicadoEm(comercianteId), instanteIso);
}
