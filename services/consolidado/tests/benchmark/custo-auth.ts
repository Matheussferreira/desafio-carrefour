/**
 * Custo isolado da validação do JWT por requisição.
 *
 * Sobe dois servidores Express idênticos que respondem {ok:true}, um sem autenticação e outro
 * com o authMiddleware real (assinatura RS256 pelo JWKS em cache, issuer, audiência, expiração e
 * escopo). As requisições alternam entre os dois, uma de cada vez, na mesma conexão keep-alive,
 * para que a deriva da máquina afete os dois por igual. A diferença é o custo da autenticação.
 *
 * Não mede banco, Redis nem Keycloak: só o que o middleware acrescenta.
 *
 * Uso: npm run bench:auth
 */
import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { authMiddleware, exigirEscopo } from '../../src/middleware/auth';
import { IdpDeTeste } from '../helpers/idp';

const AQUECIMENTO = 2_000;
const MEDIDAS = 20_000;

function servidor(app: express.Express): Promise<http.Server> {
  return new Promise(r => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => r(s));
  });
}

function chamar(agente: http.Agent, porta: number, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const inicio = process.hrtime.bigint();
    const req = http.request(
      { host: '127.0.0.1', port: porta, path: '/x', agent: agente, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      res => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve(Number(process.hrtime.bigint() - inicio) / 1e6);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function percentil(valores: number[], p: number): number {
  const o = [...valores].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor((p / 100) * o.length))];
}

function resumo(nome: string, v: number[]): string {
  const media = v.reduce((a, b) => a + b, 0) / v.length;
  return `${nome.padEnd(18)} media ${media.toFixed(3)} ms   p50 ${percentil(v, 50).toFixed(3)}   p95 ${percentil(v, 95).toFixed(3)}   p99 ${percentil(v, 99).toFixed(3)}`;
}

async function main(): Promise<void> {
  const idp = new IdpDeTeste();
  await idp.iniciar();
  const token = await idp.emitir();

  const semAuth = express();
  semAuth.get('/x', (_req, res) => res.json({ ok: true }));
  const comAuth = express();
  comAuth.get('/x', authMiddleware, exigirEscopo('consolidado.read'), (_req, res) => res.json({ ok: true }));

  const [sa, ca] = await Promise.all([servidor(semAuth), servidor(comAuth)]);
  const portaSa = (sa.address() as AddressInfo).port;
  const portaCa = (ca.address() as AddressInfo).port;
  const agente = new http.Agent({ keepAlive: true, maxSockets: 2 });

  const tSem: number[] = [];
  const tCom: number[] = [];
  for (let i = 0; i < AQUECIMENTO + MEDIDAS; i++) {
    const a = await chamar(agente, portaSa);
    const b = await chamar(agente, portaCa, token);
    if (i >= AQUECIMENTO) {
      tSem.push(a);
      tCom.push(b);
    }
  }

  console.log(`Requisições medidas por servidor: ${MEDIDAS} (após ${AQUECIMENTO} de aquecimento)`);
  console.log(resumo('sem autenticação', tSem));
  console.log(resumo('com autenticação', tCom));
  const dMedia = tCom.reduce((a, b) => a + b, 0) / MEDIDAS - tSem.reduce((a, b) => a + b, 0) / MEDIDAS;
  console.log(`Custo médio da validação do JWT: ${dMedia.toFixed(3)} ms por requisição`);
  console.log(`Chamadas ao JWKS durante a medição: ${idp.requisicoesAoJwks} (o resto vem do cache)`);

  agente.destroy();
  sa.close();
  ca.close();
  await idp.parar();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
