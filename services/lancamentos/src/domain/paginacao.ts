export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 100;

/** Posição na listagem: o instante de criação (microssegundos, em UTC) e o id do último item entregue. */
export interface Cursor {
  criadoEm: string;
  id: string;
}

const RE_INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O cursor é opaco para o cliente. Guarda o instante com microssegundos porque o Date do JS perde a precisão. */
export function codificarCursor(c: Cursor): string {
  return Buffer.from(`${c.criadoEm}|${c.id}`, 'utf8').toString('base64url');
}

/** Devolve null se o texto não for um cursor que este serviço geraria. */
export function decodificarCursor(texto: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(texto) || texto.length > 200) return null;
  const [criadoEm, id, resto] = Buffer.from(texto, 'base64url').toString('utf8').split('|');
  if (resto !== undefined || !criadoEm || !id) return null;
  if (!RE_INSTANTE.test(criadoEm) || !RE_UUID.test(id)) return null;
  return { criadoEm, id: id.toLowerCase() };
}

/** Valida o parâmetro `limite`: inteiro entre 1 e LIMITE_MAXIMO. Ausente vale LIMITE_PADRAO. */
export function lerLimite(bruto: unknown): number | null {
  if (bruto === undefined) return LIMITE_PADRAO;
  if (typeof bruto !== 'string' || !/^\d{1,4}$/.test(bruto)) return null;
  const n = Number(bruto);
  return n >= 1 && n <= LIMITE_MAXIMO ? n : null;
}
