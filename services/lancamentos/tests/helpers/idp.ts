import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { exportJWK, generateKeyPair, JWK, KeyLike, SignJWT } from 'jose';
import { config } from '../../src/config';

export interface OpcoesToken {
  clienteId?: string;
  comerciante?: string | null;
  escopos?: string[];
  audiencia?: string | string[];
  emissor?: string;
  /** Padrão '5m'. Aceita o formato do jose ('1s', '-1m' para já expirado). */
  expiraEm?: string;
  /** Assina com outra chave (não publicada no JWKS). */
  chaveAlheia?: boolean;
  /** Sem exp. */
  semExpiracao?: boolean;
}

/**
 * Provedor de identidade de teste: gera um par RSA, publica o JWKS por HTTP e emite tokens com a
 * mesma forma dos do Keycloak. Os serviços o consultam pela configuração oidcJwksUri, então o
 * caminho de validação (busca do JWKS, assinatura, issuer, audiência, expiração) é o de produção.
 */
export class IdpDeTeste {
  readonly emissor = 'http://idp.teste/realms/caixa';
  private servidor!: Server;
  private privada!: KeyLike;
  private alheia!: KeyLike;
  private jwk!: JWK;
  private kid = 'chave-de-teste-1';
  requisicoesAoJwks = 0;
  jwksIndisponivel = false;

  async iniciar(): Promise<void> {
    const par = await generateKeyPair('RS256');
    this.privada = par.privateKey;
    this.alheia = (await generateKeyPair('RS256')).privateKey;
    this.jwk = { ...(await exportJWK(par.publicKey)), kid: this.kid, alg: 'RS256', use: 'sig' };

    this.servidor = createServer((req, res) => {
      if (req.url === '/certs') {
        this.requisicoesAoJwks++;
        if (this.jwksIndisponivel) {
          res.writeHead(503).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [this.jwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(r => this.servidor.listen(0, '127.0.0.1', r));
    this.apontar();
  }

  /** Aponta a configuração dos serviços para este IdP (útil ao alternar entre vários nos testes). */
  apontar(): void {
    const { port } = this.servidor.address() as AddressInfo;
    config.oidcJwksUri = `http://127.0.0.1:${port}/certs`;
    config.oidcIssuer = this.emissor;
  }

  async parar(): Promise<void> {
    await new Promise<void>(r => this.servidor.close(() => r()));
  }

  async emitir(opcoes: OpcoesToken = {}): Promise<string> {
    const {
      clienteId = 'erp-loja-1',
      comerciante = 'loja-1',
      escopos = ['lancamentos.write', 'lancamentos.read', 'consolidado.read'],
      audiencia = [config.oidcAudience],
      emissor = this.emissor,
      expiraEm = '5m',
      chaveAlheia = false,
      semExpiracao = false,
    } = opcoes;

    const claims: Record<string, unknown> = { azp: clienteId, scope: escopos.join(' ') };
    if (comerciante !== null) claims.comerciante_id = comerciante;

    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuer(emissor)
      .setAudience(audiencia)
      .setSubject('conta-de-servico')
      .setIssuedAt();
    if (!semExpiracao) jwt = jwt.setExpirationTime(expiraEm);
    return jwt.sign(chaveAlheia ? this.alheia : this.privada);
  }

  /** Cabeçalho Authorization pronto para o supertest. */
  async cabecalho(opcoes: OpcoesToken = {}): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await this.emitir(opcoes)}` };
  }
}
