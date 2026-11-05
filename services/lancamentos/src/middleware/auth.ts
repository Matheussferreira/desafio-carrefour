import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, errors, jwtVerify, JWTPayload } from 'jose';
import { config } from '../config';
import { isComercianteId } from '../domain/comerciante';
import { sendProblem } from '../http/problem';
import { logger } from '../logger';

declare module 'express-serve-static-core' {
  interface Request {
    /** Comerciante autenticado. Vem sempre do claim do token, nunca do corpo da requisição. */
    comercianteId?: string;
    /** Cliente OAuth2 que emitiu a chamada (claim azp), para auditoria. */
    clienteId?: string;
    /** Escopos concedidos ao token. */
    escopos?: string[];
  }
}

/** Claim, fixado no cliente pelo administrador do Keycloak, que amarra a credencial a um comerciante. */
export const CLAIM_COMERCIANTE = 'comerciante_id';

// O JWKS é buscado sob demanda e fica em cache. Se o provedor de identidade cair, tokens
// assinados com chaves já conhecidas continuam sendo validados.
let jwksEmUso: { uri: string; resolver: ReturnType<typeof createRemoteJWKSet> } | null = null;

function resolverDeChaves(): ReturnType<typeof createRemoteJWKSet> {
  const uri = config.oidcJwksUri;
  if (!jwksEmUso || jwksEmUso.uri !== uri) {
    jwksEmUso = {
      uri,
      resolver: createRemoteJWKSet(new URL(uri), {
        timeoutDuration: 3_000,
        cooldownDuration: 15_000,
        cacheMaxAge: 10 * 60_000,
      }),
    };
  }
  return jwksEmUso.resolver;
}

// Falhas de rede ou resposta inesperada ao buscar o JWKS são do provedor, não do token.
function provedorIndisponivel(err: unknown): boolean {
  if (err instanceof errors.JWKSTimeout) return true;
  if (err instanceof errors.JOSEError) return err.code === 'ERR_JOSE_GENERIC' || err.code === 'ERR_JWKS_INVALID';
  return true;
}

function desafio(erro?: string, extra = ''): string {
  return erro ? `Bearer realm="caixa", error="${erro}"${extra}` : 'Bearer realm="caixa"';
}

/**
 * Autenticação: exige um JWT Bearer assinado pelo provedor de identidade (RS256, validado pelo
 * JWKS), com issuer, audiência e expiração corretos, e com o claim do comerciante.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', desafio());
    sendProblem(res, 401, 'unauthorized', 'Não autenticado', 'Envie o cabeçalho Authorization com o esquema Bearer e o token de acesso.');
    return;
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(header.slice(7), resolverDeChaves(), {
      issuer: config.oidcIssuer,
      audience: config.oidcAudience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iss'],
      clockTolerance: 5,
    }));
  } catch (err) {
    if (provedorIndisponivel(err)) {
      logger.error({ err }, 'Não foi possível obter as chaves do provedor de identidade');
      res.setHeader('Retry-After', '5');
      sendProblem(res, 503, 'identity-provider-unavailable', 'Provedor de identidade indisponível',
        'Não foi possível validar o token agora. Tente novamente em instantes.');
      return;
    }
    res.setHeader('WWW-Authenticate', desafio('invalid_token'));
    sendProblem(res, 401, 'unauthorized', 'Token inválido ou expirado');
    return;
  }

  const comerciante = payload[CLAIM_COMERCIANTE];
  if (!isComercianteId(comerciante)) {
    sendProblem(res, 403, 'merchant-claim-missing', 'Token sem comerciante',
      `O token precisa do claim ${CLAIM_COMERCIANTE} com um identificador válido.`);
    return;
  }

  req.comercianteId = comerciante;
  req.clienteId = typeof payload.azp === 'string' ? payload.azp : undefined;
  req.escopos = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  next();
}

/** Autorização: a rota só é acessível a quem recebeu o escopo (RFC 6750, insufficient_scope). */
export function exigirEscopo(escopo: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.escopos?.includes(escopo)) {
      res.setHeader('WWW-Authenticate', desafio('insufficient_scope', `, scope="${escopo}"`));
      sendProblem(res, 403, 'insufficient-scope', 'Escopo insuficiente',
        `Esta operação exige o escopo ${escopo}.`, { escopoExigido: escopo });
      return;
    }
    next();
  };
}
