import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { isComercianteId } from '../domain/comerciante';
import { sendProblem } from '../http/problem';

declare module 'express-serve-static-core' {
  interface Request {
    /** Comerciante autenticado. Vem sempre do claim do token, nunca do corpo da requisição. */
    comercianteId?: string;
  }
}

/** Nome do claim com o comerciante. Na fase de identidade passa a vir do provedor OIDC. */
export const CLAIM_COMERCIANTE = 'comerciante_id';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    sendProblem(res, 401, 'unauthorized', 'Não autenticado', 'Envie o cabeçalho Authorization: Bearer <token>.');
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(header.slice(7), config.jwtSecret);
    if (typeof decoded === 'string') throw new Error('payload inesperado');
    payload = decoded;
  } catch {
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
  next();
}
