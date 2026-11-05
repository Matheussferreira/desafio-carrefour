import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { COMERCIANTE_PADRAO, isComercianteId } from '../domain/comerciante';
import { sendProblem } from '../http/problem';
import { CLAIM_COMERCIANTE } from '../middleware/auth';

const router = Router();

// Endpoint de desenvolvimento: devolve um JWT válido sem autenticação real.
// O corpo pode trazer { "comerciante": "..." } para simular outro comerciante.
// NUNCA expor sem proteção em produção.
router.post('/login', (req: Request, res: Response) => {
  const comerciante = (req.body as { comerciante?: unknown } | undefined)?.comerciante ?? COMERCIANTE_PADRAO;
  if (!isComercianteId(comerciante)) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos',
      'comerciante deve ter de 1 a 64 caracteres entre letras, números, hífen e sublinhado.');
    return;
  }
  const token = jwt.sign(
    { sub: 'dev-user', role: 'admin', [CLAIM_COMERCIANTE]: comerciante },
    config.jwtSecret,
    { expiresIn: '24h' },
  );
  res.json({ token, comerciante });
});

export default router;
