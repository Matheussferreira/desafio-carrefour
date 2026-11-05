import { SignJWT } from 'jose';
import request from 'supertest';
import app from '../../src/app';
import { config } from '../../src/config';
import { isComercianteId } from '../../src/domain/comerciante';
import { IdpDeTeste } from '../helpers/idp';

// Todos os cenários terminam antes do banco: ou a autenticação recusa, ou a validação do corpo recusa.
const corpoInvalido = { valor: 'x', tipo: 'credito', data: '2026-06-15' };
const idp = new IdpDeTeste();

beforeAll(async () => {
  await idp.iniciar();
});

afterAll(async () => {
  await idp.parar();
});

const postar = (cab?: { Authorization: string }) => {
  const r = request(app).post('/lancamentos');
  return (cab ? r.set(cab) : r).send(corpoInvalido);
};

describe('isComercianteId', () => {
  it.each(['padrao', 'loja-1', 'Loja_2', 'a'.repeat(64)])('aceita %p', v => {
    expect(isComercianteId(v)).toBe(true);
  });

  it.each(['', 'a'.repeat(65), 'loja:1', 'loja 1', 'lo/ja', 42, null, undefined])('recusa %p', v => {
    expect(isComercianteId(v)).toBe(false);
  });
});

describe('endpoint de login de desenvolvimento foi removido', () => {
  it('POST /auth/login responde 404', async () => {
    const res = await request(app).post('/auth/login').send({ comerciante: 'loja-1' });
    expect(res.status).toBe(404);
  });
});

describe('autenticação: token recusado com 401', () => {
  it('sem cabeçalho, com desafio Bearer', async () => {
    const res = await postar();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('token que não é JWT', async () => {
    expect((await postar({ Authorization: 'Bearer isto-nao-e-um-jwt' })).status).toBe(401);
  });

  it('expirado', async () => {
    const res = await postar(await idp.cabecalho({ expiraEm: '-1m' }));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('invalid_token');
  });

  it('assinado por uma chave que não está no JWKS', async () => {
    expect((await postar(await idp.cabecalho({ chaveAlheia: true }))).status).toBe(401);
  });

  it('issuer diferente', async () => {
    expect((await postar(await idp.cabecalho({ emissor: 'http://outro-idp/realms/x' }))).status).toBe(401);
  });

  it('audiência de outra API (token do consolidado não vale no lançamentos)', async () => {
    expect((await postar(await idp.cabecalho({ audiencia: 'consolidado-api' }))).status).toBe(401);
  });

  it('sem expiração', async () => {
    expect((await postar(await idp.cabecalho({ semExpiracao: true }))).status).toBe(401);
  });

  it('HS256 assinado com um segredo qualquer (confusão de algoritmo)', async () => {
    const hs = await new SignJWT({ comerciante_id: 'loja-1', scope: 'lancamentos.write' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(idp.emissor)
      .setAudience(config.oidcAudience)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('segredo-compartilhado'));
    expect((await postar({ Authorization: `Bearer ${hs}` })).status).toBe(401);
  });

  it('alg none, sem assinatura', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const semAssinatura = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: idp.emissor,
      aud: config.oidcAudience,
      exp: Math.floor(Date.now() / 1000) + 300,
      comerciante_id: 'loja-1',
      scope: 'lancamentos.write',
    })}.`;
    expect((await postar({ Authorization: `Bearer ${semAssinatura}` })).status).toBe(401);
  });
});

describe('comerciante amarrado ao token: 403', () => {
  it('token válido sem o claim comerciante_id', async () => {
    const res = await postar(await idp.cabecalho({ comerciante: null }));
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/merchant-claim-missing');
  });

  it.each(['a:b', 'a b', ''])('claim inválido %p', async comerciante => {
    expect((await postar(await idp.cabecalho({ comerciante }))).status).toBe(403);
  });
});

describe('autorização por escopo', () => {
  it('somente leitura não registra lançamento: 403 insufficient_scope', async () => {
    const res = await postar(await idp.cabecalho({ escopos: ['lancamentos.read'] }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ type: '/problems/insufficient-scope', escopoExigido: 'lancamentos.write' });
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    expect(res.headers['www-authenticate']).toContain('lancamentos.write');
  });

  it('somente escrita não lista lançamentos', async () => {
    const res = await request(app)
      .get('/lancamentos?data=2026-02-30')
      .set(await idp.cabecalho({ escopos: ['lancamentos.write'] }));
    expect(res.status).toBe(403);
  });

  it('escopo do consolidado não abre o lançamentos', async () => {
    expect((await postar(await idp.cabecalho({ escopos: ['consolidado.read'] }))).status).toBe(403);
  });

  it('token com o escopo certo passa pela autenticação e cai na validação do corpo (400)', async () => {
    const res = await postar(await idp.cabecalho({ escopos: ['lancamentos.write'] }));
    expect(res.status).toBe(400);
  });
});

describe('JWKS', () => {
  it('as chaves ficam em cache: várias requisições, uma busca', async () => {
    const outro = new IdpDeTeste();
    await outro.iniciar();
    try {
      const cab = await outro.cabecalho();
      for (let i = 0; i < 5; i++) await postar(cab);
      expect(outro.requisicoesAoJwks).toBe(1);
    } finally {
      await outro.parar();
      idp.apontar(); // devolve a configuração ao IdP principal
    }
  });

  it('com o provedor fora do ar, token já conhecido continua válido', async () => {
    const outro = new IdpDeTeste();
    await outro.iniciar();
    try {
      const cab = await outro.cabecalho();
      expect((await postar(cab)).status).toBe(400); // carrega as chaves
      outro.jwksIndisponivel = true;
      expect((await postar(cab)).status).toBe(400); // segue validando pelo cache
    } finally {
      await outro.parar();
      idp.apontar();
    }
  });

  it('sem nunca ter obtido as chaves e com o provedor fora do ar: 503 com Retry-After', async () => {
    const outro = new IdpDeTeste();
    await outro.iniciar();
    outro.jwksIndisponivel = true;
    try {
      const res = await postar(await outro.cabecalho());
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.type).toBe('/problems/identity-provider-unavailable');
    } finally {
      await outro.parar();
      idp.apontar();
    }
  });
});
