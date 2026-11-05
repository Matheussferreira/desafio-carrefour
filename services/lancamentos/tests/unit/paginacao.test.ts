import { codificarCursor, decodificarCursor, lerLimite, LIMITE_MAXIMO, LIMITE_PADRAO } from '../../src/domain/paginacao';

const ID = '0b9c2f1e-7d3a-4f60-9a1e-5c8d2b7e4a10';
const INSTANTE = '2026-03-10T14:30:00.123456Z';

describe('cursor de paginação', () => {
  it('codifica e decodifica sem perder a precisão de microssegundos', () => {
    const cursor = codificarCursor({ criadoEm: INSTANTE, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodificarCursor(cursor)).toEqual({ criadoEm: INSTANTE, id: ID });
  });

  it.each([
    ['lixo', 'texto que não é um cursor'],
    ['', 'vazio'],
    ['a+b/c=', 'caracteres fora do alfabeto base64url'],
    [Buffer.from('2026-03-10T14:30:00Z|' + ID).toString('base64url'), 'instante sem microssegundos'],
    [Buffer.from(INSTANTE + '|nao-e-uuid').toString('base64url'), 'id que não é UUID'],
    [Buffer.from(INSTANTE + '|' + ID + '|extra').toString('base64url'), 'campo a mais'],
    [Buffer.from("2026-03-10T14:30:00.123456Z'; DROP TABLE lancamentos;--|" + ID).toString('base64url'), 'tentativa de injeção'],
    ['A'.repeat(300), 'grande demais'],
  ])('recusa %s (%s)', texto => {
    expect(decodificarCursor(texto)).toBeNull();
  });
});

describe('limite de página', () => {
  it('ausente vale o padrão', () => {
    expect(lerLimite(undefined)).toBe(LIMITE_PADRAO);
  });

  it('aceita de 1 ao máximo', () => {
    expect(lerLimite('1')).toBe(1);
    expect(lerLimite(String(LIMITE_MAXIMO))).toBe(LIMITE_MAXIMO);
  });

  it.each(['0', '-1', String(LIMITE_MAXIMO + 1), '1.5', 'abc', '', '1e2', '00000001'])('recusa %p', valor => {
    expect(lerLimite(valor)).toBeNull();
  });

  it('recusa valor que não é texto (parâmetro repetido)', () => {
    expect(lerLimite(['1', '2'])).toBeNull();
  });
});
