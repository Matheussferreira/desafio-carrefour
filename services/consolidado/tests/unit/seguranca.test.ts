import { SignJWT } from 'jose';
import request from 'supertest';
import app from '../../src/app';
import { config } from '../../src/config';
import { isComercianteId } from '../../src/domain/comerciante';
import { IdpDeTeste } from '../helpers/idp';

// Todos os cenários terminam antes do banco: ou a autenticação recusa, ou a validação da data recusa.
const idp = new IdpDeTeste();

beforeAll(async () => {
  await idp.iniciar();
});

afterAll(async () => {
  await idp.parar();
});

const DATA_INVALIDA = '/consolidado/2026-02-30';
const consultar = (cab?: { Authorization: string }) => {
  const r = request(app).get(DATA_INVALIDA);
  return cab ? r.set(cab) : r;
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
    const res = await consultar();
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('token que não é JWT', async () => {
    expect((await consultar({ Authorization: 'Bearer isto-nao-e-um-jwt' })).status).toBe(401);
  });

  it('expirado', async () => {
    const res = await consultar(await idp.cabecalho({ expiraEm: '-1m' }));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('invalid_token');
  });

  it('assinado por uma chave que não está no JWKS', async () => {
    expect((await consultar(await idp.cabecalho({ chaveAlheia: true }))).status).toBe(401);
  });

  it('issuer diferente', async () => {
    expect((await consultar(await idp.cabecalho({ emissor: 'http://outro-idp/realms/x' }))).status).toBe(401);
  });

  it('audiência de outra API (token do lançamentos não vale no consolidado)', async () => {
    expect((await consultar(await idp.cabecalho({ audiencia: 'lancamentos-api' }))).status).toBe(401);
  });

  it('sem expiração', async () => {
    expect((await consultar(await idp.cabecalho({ semExpiracao: true }))).status).toBe(401);
  });

  it('HS256 assinado com um segredo qualquer (confusão de algoritmo)', async () => {
    const hs = await new SignJWT({ comerciante_id: 'loja-1', scope: 'consolidado.read' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(idp.emissor)
      .setAudience(config.oidcAudience)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('segredo-compartilhado'));
    expect((await consultar({ Authorization: `Bearer ${hs}` })).status).toBe(401);
  });

  it('alg none, sem assinatura', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const semAssinatura = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: idp.emissor,
      aud: config.oidcAudience,
      exp: Math.floor(Date.now() / 1000) + 300,
      comerciante_id: 'loja-1',
      scope: 'consolidado.read',
    })}.`;
    expect((await consultar({ Authorization: `Bearer ${semAssinatura}` })).status).toBe(401);
  });
});

describe('comerciante amarrado ao token: 403', () => {
  it('token válido sem o claim comerciante_id', async () => {
    const res = await consultar(await idp.cabecalho({ comerciante: null }));
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/merchant-claim-missing');
  });

  it.each(['a:b', 'a b', ''])('claim inválido %p', async comerciante => {
    expect((await consultar(await idp.cabecalho({ comerciante }))).status).toBe(403);
  });
});

describe('autorização por escopo', () => {
  it('escopo de lançamentos não abre o consolidado: 403 insufficient_scope', async () => {
    const res = await consultar(await idp.cabecalho({ escopos: ['lancamentos.read', 'lancamentos.write'] }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ type: '/problems/insufficient-scope', escopoExigido: 'consolidado.read' });
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
  });

  it('token sem nenhum escopo é recusado', async () => {
    expect((await consultar(await idp.cabecalho({ escopos: [] }))).status).toBe(403);
  });

  it('o intervalo exige o mesmo escopo', async () => {
    const res = await request(app)
      .get('/consolidado?inicio=2026-06-01&fim=2026-06-02')
      .set(await idp.cabecalho({ escopos: ['lancamentos.read'] }));
    expect(res.status).toBe(403);
  });

  it('com consolidado.read passa pela autenticação e cai na validação da data (400)', async () => {
    const res = await consultar(await idp.cabecalho({ escopos: ['consolidado.read'] }));
    expect(res.status).toBe(400);
  });
});

describe('JWKS', () => {
  it('as chaves ficam em cache: várias requisições, uma busca', async () => {
    const outro = new IdpDeTeste();
    await outro.iniciar();
    try {
      const cab = await outro.cabecalho();
      for (let i = 0; i < 5; i++) await consultar(cab);
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
      expect((await consultar(cab)).status).toBe(400); // carrega as chaves
      outro.jwksIndisponivel = true;
      expect((await consultar(cab)).status).toBe(400); // segue validando pelo cache
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
      const res = await consultar(await outro.cabecalho());
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.type).toBe('/problems/identity-provider-unavailable');
    } finally {
      await outro.parar();
      idp.apontar();
    }
  });
});
