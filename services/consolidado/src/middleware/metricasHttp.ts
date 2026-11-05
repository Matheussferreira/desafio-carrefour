import { NextFunction, Request, Response } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '../metrics';

/**
 * Alimenta o contador e o histograma de HTTP. O rótulo `route` usa o padrão da rota
 * (por exemplo /consolidado/:data) e não a URL real, para não criar uma série por data.
 * Respostas que não chegaram a uma rota (401 do auth, 429 do limitador, 404) caem no
 * prefixo de montagem ou em "desconhecida".
 */
export function metricasHttp(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/metrics') {
    next();
    return;
  }
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const rota = req.route ? `${req.baseUrl}${req.route.path === '/' ? '' : req.route.path}` : req.baseUrl || 'desconhecida';
    const rotulos = { method: req.method, route: rota, status: String(res.statusCode) };
    httpRequestsTotal.inc(rotulos);
    httpRequestDuration.observe(rotulos, Number(process.hrtime.bigint() - inicio) / 1e9);
  });
  next();
}
