import pino from 'pino';
import { idsDoTraceAtivo } from './telemetria';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // traceId e spanId do trace ativo em cada linha, para cruzar log e trace
  mixin: () => idsDoTraceAtivo(),
  base: { service: 'lancamentos' },
});
