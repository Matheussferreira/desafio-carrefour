import { calcularDelta, interpretarMensagem } from '../../src/domain/evento';

const eventoValido = {
  eventoId: '11111111-1111-4111-8111-111111111111',
  schemaVersion: '1.0',
  tipo: 'LancamentoRegistrado',
  correlationId: 'corr-1',
  createdAt: '2026-06-15T12:00:00.000Z',
  data: {
    lancamentoId: '22222222-2222-4222-8222-222222222222',
    valor: '1500.00',
    tipo: 'credito',
    descricao: 'Venda',
    data: '2026-06-15',
  },
};

const comoMensagem = (o: unknown) => JSON.stringify(o);

describe('calcularDelta', () => {
  it('crédito soma em créditos e no saldo', () => {
    expect(calcularDelta('credito', '1500.5')).toEqual({ creditos: '1500.50', debitos: '0.00', saldo: '1500.50' });
  });

  it('débito soma em débitos e reduz o saldo', () => {
    expect(calcularDelta('debito', '200.50')).toEqual({ creditos: '0.00', debitos: '200.50', saldo: '-200.50' });
  });

  it('não sofre erro de ponto flutuante', () => {
    // 0.1 + 0.2 em float dá 0.30000000000000004
    const a = calcularDelta('credito', '0.10');
    const b = calcularDelta('credito', '0.20');
    expect((Number(a.saldo) + Number(b.saldo)).toFixed(2)).toBe('0.30');
    expect(a.saldo).toBe('0.10');
  });
});

describe('interpretarMensagem', () => {
  it('aceita um evento válido', () => {
    const r = interpretarMensagem(comoMensagem(eventoValido));
    expect(r.tipo).toBe('evento');
    if (r.tipo === 'evento') expect(r.evento.data.data).toBe('2026-06-15');
  });

  it('aceita descrição nula', () => {
    const r = interpretarMensagem(comoMensagem({ ...eventoValido, data: { ...eventoValido.data, descricao: null } }));
    expect(r.tipo).toBe('evento');
  });

  it('rejeita data em formato de timestamp (contrato exige YYYY-MM-DD)', () => {
    const r = interpretarMensagem(
      comoMensagem({ ...eventoValido, data: { ...eventoValido.data, data: '2026-06-15T03:00:00.000Z' } }),
    );
    expect(r.tipo).toBe('invalido');
  });

  it.each(['2026-02-30', 'ontem', ''])('rejeita data %p', data => {
    const r = interpretarMensagem(comoMensagem({ ...eventoValido, data: { ...eventoValido.data, data } }));
    expect(r.tipo).toBe('invalido');
  });

  it.each(['abc', '-10.00', '0.00', '10.005', '99999999999999.00'])('rejeita valor %p', valor => {
    const r = interpretarMensagem(comoMensagem({ ...eventoValido, data: { ...eventoValido.data, valor } }));
    expect(r.tipo).toBe('invalido');
  });

  it('rejeita eventoId que não é UUID', () => {
    expect(interpretarMensagem(comoMensagem({ ...eventoValido, eventoId: '123' })).tipo).toBe('invalido');
  });

  it('JSON malformado e corpo que não é objeto são inválidos', () => {
    expect(interpretarMensagem('{nao-e-json').tipo).toBe('invalido');
    expect(interpretarMensagem('42').tipo).toBe('invalido');
    expect(interpretarMensagem('null').tipo).toBe('invalido');
  });

  it('tipo de evento desconhecido é ignorado, não rejeitado', () => {
    expect(interpretarMensagem(comoMensagem({ tipo: 'LancamentoEstornado', x: 1 }))).toEqual({
      tipo: 'ignorado',
      tipoEvento: 'LancamentoEstornado',
    });
  });
});
