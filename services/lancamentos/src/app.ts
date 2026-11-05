import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { rateLimiter } from './middleware/rateLimit';
import { authMiddleware } from './middleware/auth';
import healthRouter from './routes/health';
import lancamentosRouter from './routes/lancamentos';
import { register } from './metrics';
import { errorHandler, notFoundHandler } from './http/problem';

const app = express();

app.use(express.json());
app.use(
  pinoHttp({
    logger,
    // Nunca registrar credenciais; registrar quem chamou (cliente e comerciante) para auditoria
    redact: ['req.headers.authorization'],
    customProps: req => ({ clienteId: req.clienteId, comercianteId: req.comercianteId }),
  }),
);

// Endpoints isentos de rate limiting: não consomem cota de negócio e um 429 aqui
// pode matar um container saudável (orquestrador) ou interromper scraping do Prometheus.
app.use('/', healthRouter);
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Rate limiting aplicado apenas às rotas de negócio
app.use('/lancamentos', rateLimiter, authMiddleware, lancamentosRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
