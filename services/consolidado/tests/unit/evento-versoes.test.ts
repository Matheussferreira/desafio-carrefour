import { interpretarMensagem } from '../../src/domain/evento';

const base = {
  eventoId: '11111111-1111-4111-8111-111111111111',
  tipo: 'LancamentoRegistrado',
  createdAt: '2026-06-15T12:00:00.000Z',
  data: {
    lancamentoId: '22222222-2222-4222-8222-222222222222',
    valor: '10.00',
    tipo: 'credito',
    descricao: null,
    data: '2026-06-15',
  },
};
const msg = (extra: object) => JSON.stringify({ ...base, ...extra });

describe('versionamento do evento LancamentoRegistrado', () => {
  it('1.0 não tem comercianteId e vira o comerciante padrão', () => {
    const r = interpretarMensagem(msg({ schemaVersion: '1.0' }));
    expect(r.tipo).toBe('evento');
    if (r.tipo === 'evento') expect(r.evento.comercianteId).toBe('padrao');
  });

  it('sem schemaVersion é tratado como 1.0', () => {
    const r = interpretarMensagem(msg({}));
    expect(r.tipo).toBe('evento');
    if (r.tipo === 'evento') expect(r.evento.comercianteId).toBe('padrao');
  });

  it('1.1 carrega o comercianteId informado', () => {
    const r = interpretarMensagem(msg({ schemaVersion: '1.1', comercianteId: 'loja-7' }));
    expect(r.tipo).toBe('evento');
    if (r.tipo === 'evento') expect(r.evento.comercianteId).toBe('loja-7');
  });

  it('1.1 sem comercianteId é inválido', () => {
    const r = interpretarMensagem(msg({ schemaVersion: '1.1' }));
    expect(r).toMatchObject({ tipo: 'invalido' });
    if (r.tipo === 'invalido') expect(r.motivo).toContain('comercianteId');
  });

  it('1.0 com comercianteId também é aceito (produtor adiantado)', () => {
    const r = interpretarMensagem(msg({ schemaVersion: '1.0', comercianteId: 'loja-7' }));
    expect(r.tipo).toBe('evento');
  });

  it('versão menor futura (1.2) é aceita e campos desconhecidos são ignorados', () => {
    const r = interpretarMensagem(msg({ schemaVersion: '1.2', comercianteId: 'loja-7', canalDeVenda: 'app' }));
    expect(r.tipo).toBe('evento');
    if (r.tipo === 'evento') expect(r.evento).not.toHaveProperty('canalDeVenda');
  });

  it('versão maior (2.0) é recusada: mudança incompatível vai para a DLQ', () => {
    const r = interpretarMensagem(msg({ schemaVersion: '2.0', comercianteId: 'loja-7' }));
    expect(r.tipo).toBe('invalido');
    if (r.tipo === 'invalido') expect(r.motivo).toContain('não suportada');
  });

  it.each(['abc', '1', '1.x', ''])('schemaVersion malformado %p é inválido', schemaVersion => {
    expect(interpretarMensagem(msg({ schemaVersion, comercianteId: 'loja-7' })).tipo).toBe('invalido');
  });

  it.each(['loja:1', 'loja 1', '', 'a'.repeat(65)])('comercianteId inválido %p', comercianteId => {
    expect(interpretarMensagem(msg({ schemaVersion: '1.1', comercianteId })).tipo).toBe('invalido');
  });

  it('createdAt que não é data-hora ISO é inválido', () => {
    expect(interpretarMensagem(msg({ schemaVersion: '1.1', comercianteId: 'a', createdAt: 'ontem' })).tipo).toBe(
      'invalido',
    );
  });
});
