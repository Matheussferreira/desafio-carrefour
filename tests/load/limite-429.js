/**
 * Prova determinística do 429 do limitador do consolidado.
 *
 * O consolidado precisa estar com RATE_LIMIT_MAX baixo (300 por minuto), o que
 * tests/load/limite-429.ps1 (ou .sh) faz subindo o docker-compose.ratelimit.yml.
 *
 * O limitador usa janela fixa de 1 minuto. Um VU sequencial envia LIMITE * 2 + 100
 * requisições seguidas, que levam poucos segundos. Mesmo que a janela vire no meio
 * da rajada, no máximo LIMITE respostas 200 cabem em cada janela, então o 429
 * aparece sempre: não depende de em que ponto da janela o teste começa.
 */

import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

const resp200 = new Counter('limite_respostas_200');
const resp429 = new Counter('limite_respostas_429');
const respOutras = new Counter('limite_respostas_outras');
const semRetryAfter = new Rate('limite_429_sem_retry_after');

const CONSOLIDADO_URL = __ENV.CONSOLIDADO_URL || 'http://localhost:3002';
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://localhost:8080';
const CLIENT_ID = __ENV.CLIENT_ID || 'erp-loja-1';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'dev-segredo-erp-loja-1';
const LIMITE = Number(__ENV.RATE_LIMIT_MAX || 300);
const TEST_DATE = __ENV.TEST_DATE || '2026-06-27';

export const options = {
  scenarios: {
    rajada: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '50s',
    },
  },
  thresholds: {
    limite_respostas_429: ['count>0'],
    limite_429_sem_retry_after: ['rate==0'],
    limite_respostas_outras: ['count==0'],
    limite_respostas_200: ['count>0'],
  },
};

export function setup() {
  const res = http.post(`${KEYCLOAK_URL}/realms/caixa/protocol/openid-connect/token`, {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  if (res.status !== 200) {
    throw new Error(`[setup] Token no Keycloak falhou: HTTP ${res.status} ${res.body}`);
  }
  return { token: res.json('access_token') };
}

export default function (data) {
  const total = LIMITE * 2 + 100;
  const params = {
    headers: { Authorization: `Bearer ${data.token}` },
    responseCallback: http.expectedStatuses(200, 429),
  };
  for (let i = 0; i < total; i++) {
    const res = http.get(`${CONSOLIDADO_URL}/consolidado/${TEST_DATE}`, params);
    if (res.status === 200) {
      resp200.add(1);
    } else if (res.status === 429) {
      resp429.add(1);
      semRetryAfter.add(!res.headers['Retry-After']);
    } else {
      respOutras.add(1);
    }
  }
}
