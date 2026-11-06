/**
 * Cenário curto para medir rápido: só cache_hit, 50 req/s por 30 s, mesma data.
 * Serve para comparar versões do código ou configurações da mesma stack.
 *
 * AUTH=keycloak (padrão): token por client credentials no Keycloak.
 * AUTH=login: token pelo /auth/login de desenvolvimento, que só existe nos commits anteriores à autenticação por Keycloak (até 98f9fb2).
 *
 * Uso: docker compose --profile loadtest run --rm k6 run /scripts/curto.js
 */
import http from 'k6/http';

const DATA = __ENV.TEST_DATE || '2026-06-27';
const AUTH = __ENV.AUTH || 'keycloak';
const LANCAMENTOS_URL = __ENV.LANCAMENTOS_URL || 'http://localhost:3001';
const CONSOLIDADO_URL = __ENV.CONSOLIDADO_URL || 'http://localhost:3002';
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://localhost:8080';
const CLIENT_ID = __ENV.CLIENT_ID || 'erp-loja-1';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'dev-segredo-erp-loja-1';

export const options = {
  scenarios: {
    cache_hit: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
  },
  thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.05'] },
};

function obterToken() {
  if (AUTH === 'login') {
    const r = http.post(`${LANCAMENTOS_URL}/auth/login`, JSON.stringify({ comerciante: 'loja-1' }), {
      headers: { 'Content-Type': 'application/json' },
    });
    if (r.status !== 200) throw new Error(`Login falhou: HTTP ${r.status}`);
    return r.json('token');
  }
  const r = http.post(`${KEYCLOAK_URL}/realms/caixa/protocol/openid-connect/token`, {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  if (r.status !== 200) throw new Error(`Token falhou: HTTP ${r.status}`);
  return r.json('access_token');
}

export function setup() {
  const token = obterToken();
  for (let i = 0; i < 5; i++) {
    http.post(
      `${LANCAMENTOS_URL}/lancamentos`,
      JSON.stringify({ valor: '10.00', tipo: 'credito', data: DATA, descricao: 'curto' }),
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Idempotency-Key': `curto-${DATA}-${i}` } },
    );
  }
  http.get(`${CONSOLIDADO_URL}/consolidado/${DATA}`, { headers: { Authorization: `Bearer ${token}` } });
  // Espera o consolidado aplicar os eventos e o cache esquentar
  const fim = Date.now() + 8000;
  while (Date.now() < fim) http.get(`${CONSOLIDADO_URL}/consolidado/${DATA}`, { headers: { Authorization: `Bearer ${token}` } });
  return { token };
}

export default function (data) {
  http.get(`${CONSOLIDADO_URL}/consolidado/${DATA}`, { headers: { Authorization: `Bearer ${data.token}` } });
}
