/**
 * Medição controlada de latência: 50 req/s por 45 s na mesma data (cache quente), sem
 * nenhum outro cenário. Serve para comparar configurações da mesma stack (com e sem tracing,
 * com e sem o profile de observabilidade) rodando este mesmo arquivo em cada uma.
 *
 * Uso: docker compose --profile loadtest run --rm k6 run /scripts/ablacao.js
 */
import http from 'k6/http';

const DATA = __ENV.TEST_DATE || '2026-06-27';
const LANCAMENTOS_URL = __ENV.LANCAMENTOS_URL || 'http://localhost:3001';
const CONSOLIDADO_URL = __ENV.CONSOLIDADO_URL || 'http://localhost:3002';
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://localhost:8080';
const CLIENT_ID = __ENV.CLIENT_ID || 'erp-loja-1';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'dev-segredo-erp-loja-1';

export const options = {
  scenarios: {
    quente: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '45s',
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
  },
  thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.05'] },
};

export function setup() {
  const t = http.post(`${KEYCLOAK_URL}/realms/caixa/protocol/openid-connect/token`, {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  if (t.status !== 200) throw new Error(`Token falhou: HTTP ${t.status}`);
  const token = t.json('access_token');
  // Garante que a data existe e aquece o cache
  http.post(
    `${LANCAMENTOS_URL}/lancamentos`,
    JSON.stringify({ valor: '10.00', tipo: 'credito', data: DATA, descricao: 'ablacao' }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Idempotency-Key': `ablacao-${DATA}` } },
  );
  for (let i = 0; i < 20; i++) http.get(`${CONSOLIDADO_URL}/consolidado/${DATA}`, { headers: { Authorization: `Bearer ${token}` } });
  return { token };
}

export default function (data) {
  http.get(`${CONSOLIDADO_URL}/consolidado/${DATA}`, { headers: { Authorization: `Bearer ${data.token}` } });
}
