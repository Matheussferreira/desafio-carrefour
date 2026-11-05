import { config } from '../config';
import { getRedis } from '../redis';

// Chaves, todas por comerciante:
//   saldo:{comerciante}:{data}   resposta do dia (JSON) com TTL
//   saldo:idx:{comerciante}      sorted set com as datas em cache (score = YYYYMMDD), para
//                                invalidar "a partir de uma data" sem varrer o Redis
//   saldo:ate:{comerciante}      instante do último evento aplicado (atualizadoAte)
// O identificador do comerciante não admite dois-pontos, então as chaves não colidem.

export const chaveSaldo = (comercianteId: string, data: string): string => `saldo:${comercianteId}:${data}`;
export const chaveIndice = (comercianteId: string): string => `saldo:idx:${comercianteId}`;
export const chaveAtualizadoAte = (comercianteId: string): string => `saldo:ate:${comercianteId}`;

/** 2026-06-15 vira 20260615, ordenável como número. */
export const scoreDaData = (data: string): number => Number(data.replace(/-/g, ''));

export async function lerSaldo<T>(comercianteId: string, data: string): Promise<T | null> {
  const bruto = await getRedis().get(chaveSaldo(comercianteId, data));
  return bruto ? (JSON.parse(bruto) as T) : null;
}

export async function gravarSaldo(comercianteId: string, data: string, valor: object): Promise<void> {
  const ttl = config.cacheTtlSeconds;
  const indice = chaveIndice(comercianteId);
  await getRedis()
    .multi()
    .setex(chaveSaldo(comercianteId, data), ttl, JSON.stringify(valor))
    .zadd(indice, scoreDaData(data), data)
    // O índice precisa sobreviver a todas as chaves que ele aponta; ele é renovado a cada gravação
    .expire(indice, ttl + 60)
    .exec();
}

/**
 * Apaga do cache o saldo da data e de todas as datas posteriores do comerciante, que é o
 * alcance de um lançamento naquela data (o acumulado das datas seguintes também muda).
 * Datas anteriores continuam em cache. Devolve quantas chaves foram apagadas.
 */
export async function invalidarAPartirDe(comercianteId: string, data: string): Promise<number> {
  const redis = getRedis();
  const indice = chaveIndice(comercianteId);
  const score = scoreDaData(data);
  const datas = await redis.zrangebyscore(indice, score, '+inf');
  if (datas.length === 0) return 0;
  await redis
    .multi()
    .del(...datas.map(d => chaveSaldo(comercianteId, d)))
    .zremrangebyscore(indice, score, '+inf')
    .exec();
  return datas.length;
}

export async function lerAtualizadoAte(comercianteId: string): Promise<string | null> {
  return getRedis().get(chaveAtualizadoAte(comercianteId));
}

export async function gravarAtualizadoAte(comercianteId: string, instanteIso: string): Promise<void> {
  await getRedis().set(chaveAtualizadoAte(comercianteId), instanteIso);
}
