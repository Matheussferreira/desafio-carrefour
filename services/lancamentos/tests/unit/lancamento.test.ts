import { isDataReal } from '../../src/domain/data';
import {
  hashCorpo,
  lancamentoSchema,
  normalizarValor,
  VALOR_MAXIMO,
} from '../../src/domain/lancamento';

const valido = { valor: '150.00', tipo: 'credito', data: '2026-06-15' };

function erros(corpo: unknown): string[] {
  const r = lancamentoSchema.safeParse(corpo);
  return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
}

describe('lancamentoSchema', () => {
  it('aceita crédito e débito válidos', () => {
    expect(lancamentoSchema.safeParse(valido).success).toBe(true);
    expect(
      lancamentoSchema.safeParse({ ...valido, tipo: 'debito', valor: '0.01', descricao: 'Fornecedor' }).success,
    ).toBe(true);
  });

  it('aceita valor sem casas decimais e com uma casa', () => {
    expect(lancamentoSchema.safeParse({ ...valido, valor: '100' }).success).toBe(true);
    expect(lancamentoSchema.safeParse({ ...valido, valor: '100.5' }).success).toBe(true);
  });

  it('rejeita valor numérico: o JSON já chegaria como float', () => {
    const e = erros({ ...valido, valor: 150 });
    expect(e).toEqual(['valor: valor deve ser uma string decimal, por exemplo "150.00"']);
  });

  it.each(['10.005', '1e3', '-5.00', '', 'abc', '1,50', ' 10.00'])(
    'rejeita valor malformado %p',
    valor => {
      expect(erros({ ...valido, valor }).length).toBeGreaterThan(0);
    },
  );

  it.each(['0', '0.00', '000.00'])('rejeita valor zero %p', valor => {
    expect(erros({ ...valido, valor })).toContain('valor: valor deve ser maior que zero');
  });

  it('aceita o valor máximo e rejeita um centavo acima', () => {
    expect(lancamentoSchema.safeParse({ ...valido, valor: VALOR_MAXIMO }).success).toBe(true);
    expect(erros({ ...valido, valor: '1000000000.00' }).length).toBeGreaterThan(0);
  });

  it('rejeita tipo desconhecido e campos ausentes', () => {
    expect(erros({ ...valido, tipo: 'transferencia' })).toEqual(['tipo: tipo deve ser "credito" ou "debito"']);
    expect(erros({})).toEqual(
      expect.arrayContaining(['valor: valor é obrigatório', 'data: data é obrigatória']),
    );
  });

  it('rejeita descrição acima de 500 caracteres', () => {
    expect(erros({ ...valido, descricao: 'x'.repeat(501) }).length).toBe(1);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '15/06/2026', '2026-6-15', '2026-06-15T00:00:00Z'])(
    'rejeita data inválida %p',
    data => {
      expect(erros({ ...valido, data })).toEqual(['data: data deve ser uma data real no formato YYYY-MM-DD']);
    },
  );
});

describe('isDataReal', () => {
  it('trata ano bissexto corretamente', () => {
    expect(isDataReal('2028-02-29')).toBe(true);
    expect(isDataReal('2026-02-29')).toBe(false);
    expect(isDataReal('1900-02-29')).toBe(false);
    expect(isDataReal('2000-02-29')).toBe(true);
  });
});

describe('hashCorpo', () => {
  const base = { valor: '100.00', tipo: 'credito' as const, data: '2026-06-15', descricao: 'Venda' };

  it('é estável e independe da formatação do valor', () => {
    expect(hashCorpo(base)).toBe(hashCorpo({ ...base }));
    expect(hashCorpo({ ...base, valor: '100' })).toBe(hashCorpo(base));
    expect(hashCorpo({ ...base, valor: '100.0' })).toBe(hashCorpo(base));
  });

  it('descrição ausente e omitida geram o mesmo hash', () => {
    const { descricao: _d, ...semDescricao } = base;
    expect(hashCorpo(semDescricao)).toBe(hashCorpo({ ...semDescricao, descricao: undefined }));
  });

  it.each([
    ['valor', { valor: '100.01' }],
    ['tipo', { tipo: 'debito' as const }],
    ['data', { data: '2026-06-16' }],
    ['descricao', { descricao: 'Outra' }],
  ])('muda quando %s muda', (_campo, alteracao) => {
    expect(hashCorpo({ ...base, ...alteracao })).not.toBe(hashCorpo(base));
  });
});

describe('normalizarValor', () => {
  it('usa duas casas', () => {
    expect(normalizarValor('7')).toBe('7.00');
    expect(normalizarValor('7.5')).toBe('7.50');
  });
});
