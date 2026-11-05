import { erroTransitorio } from '../../src/utils/erroTransitorio';

function comCodigo(mensagem: string, code: string): Error {
  return Object.assign(new Error(mensagem), { code });
}

describe('erroTransitorio', () => {
  it.each([
    ['57P03', 'banco que não aceita conexões'],
    ['57P01', 'conexão derrubada pelo administrador'],
    ['57P02', 'recuperação após crash'],
    ['53300', 'excesso de conexões'],
    ['08006', 'falha de conexão (classe 08)'],
    ['08P01', 'protocolo (classe 08)'],
    ['40001', 'falha de serialização'],
    ['40P01', 'deadlock'],
    ['ECONNREFUSED', 'conexão recusada'],
    ['ECONNRESET', 'conexão reiniciada'],
    ['ETIMEDOUT', 'tempo esgotado na rede'],
  ])('%s (%s) é transitório', codigo => {
    expect(erroTransitorio(comCodigo('falha', codigo))).toBe(true);
  });

  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    'terminating connection due to administrator command',
    'Client has encountered a connection error and is not queryable',
    'the database system is starting up',
    'database "consolidado_db" is not currently accepting connections',
  ])('reconhece pela mensagem: %s', mensagem => {
    expect(erroTransitorio(new Error(mensagem))).toBe(true);
  });

  it('olha dentro de AggregateError (conexão a IPv4 e IPv6 que falhou)', () => {
    const agregado = new AggregateError([comCodigo('v6', 'ECONNREFUSED'), comCodigo('v4', 'ECONNREFUSED')]);
    expect(erroTransitorio(agregado)).toBe(true);
  });

  it.each([
    ['22003', 'valor numérico fora do intervalo'],
    ['22P02', 'texto inválido para o tipo'],
    ['23505', 'violação de unicidade'],
    ['23514', 'violação de check'],
    ['42P01', 'tabela inexistente'],
  ])('%s (%s) é permanente e pode ir para a DLQ', codigo => {
    expect(erroTransitorio(comCodigo('erro do dado', codigo))).toBe(false);
  });

  it('erro de programação e valores que não são Error são permanentes', () => {
    expect(erroTransitorio(new TypeError('x is not a function'))).toBe(false);
    expect(erroTransitorio('texto')).toBe(false);
    expect(erroTransitorio(undefined)).toBe(false);
  });
});
