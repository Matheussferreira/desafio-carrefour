/**
 * Teste de carga k6 — Fase 4
 *
 * PROVA o requisito NF-02:
 *   "Em dias de pico, o serviço de consolidado recebe 50 req/s,
 *    com no máximo 5% de perda de requisições."
 *
 * Dois cenários rodados em SEQUÊNCIA (não simultâneos):
 *
 *   cache_hit  (T=0–60s)  — mesma data repetida → Redis hit após 1ª req.
 *                            Prova: throughput máximo, caminho quente.
 *
 *   cache_miss (T=70–130s) — 60 datas distintas rotacionando.
 *                            Setup não aquece o cache dessas datas; à época
 *                            que o cenário inicia (T=70s), o TTL de 60s já
 *                            expirou para todas as datas verificadas em setup.
 *                            1ª passagem (≈60 req): Postgres puro.
 *                            Passagens seguintes: Redis.
 *                            Prova: Postgres sob 50 req/s, sem perdas.
 *
 *   pico_acima_do_limite (T=140–180s) — 200 req/s por 40 s, acima dos 100 req/s da cota
 *                            do limitador (6.000 req/min por IP). Prova que só aparecem
 *                            200 e 429, todo 429 com Retry-After, sem 5xx. Se haverá 429
 *                            depende do alinhamento da janela fixa de 1 min, então a
 *                            existência do 429 é provada em limite-429.js.
 *                            Estas respostas não entram no cálculo de perda do NF-02.
 *
 * Definição de "perda": qualquer resposta ≠ HTTP 200.
 * Threshold: não_ok_rate < 5% (exit != 0 se violado).
 * Rate limiter ligado: 6.000 req/min (100 req/s) — teste usa 50% da cota.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';

const nonOkRate = new Rate('non_ok_rate');
// Cenário de pico: o que o limitador de taxa devolve acima da cota
const pico200 = new Counter('pico_respostas_200');
const pico429 = new Counter('pico_respostas_429');
const picoOutros = new Counter('pico_respostas_outras');
const picoSemRetryAfter = new Rate('pico_429_sem_retry_after');

const TEST_DATE       = __ENV.TEST_DATE       || '2026-06-27';
const LANCAMENTOS_URL = __ENV.LANCAMENTOS_URL || 'http://localhost:3001';
const CONSOLIDADO_URL = __ENV.CONSOLIDADO_URL || 'http://localhost:3002';
const KEYCLOAK_URL    = __ENV.KEYCLOAK_URL    || 'http://localhost:8080';
const CLIENT_ID       = __ENV.CLIENT_ID       || 'erp-loja-1';
const CLIENT_SECRET   = __ENV.CLIENT_SECRET   || 'dev-segredo-erp-loja-1';

// 60 datas distintas para o cenário cache_miss.
// Intervalo escolhido no passado recente (fev–abr 2026): sem conflito com TEST_DATE.
const CACHE_MISS_DATES = Array.from({ length: 60 }, (_, i) => {
  const d = new Date('2026-02-01');
  d.setDate(d.getDate() + i);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
});

export const options = {
  scenarios: {
    cache_hit: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,  // headroom para pico de latência (max observado ≈600ms → 30 VUs simultâneos)
      maxVUs: 150,
      startTime: '0s',
      exec: 'cacheHitScenario',
    },
    cache_miss: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,
      maxVUs: 150,
      startTime: '70s',  // após cache_hit (60s) + 10s de folga
      exec: 'cacheMissScenario',
    },
    pico_acima_do_limite: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '40s',
      preAllocatedVUs: 100,
      maxVUs: 400,
      startTime: '140s',
      exec: 'picoScenario',
    },
  },
  thresholds: {
    non_ok_rate:       ['rate<0.05'],
    'http_req_failed{scenario:cache_hit}':  ['rate<0.05'],
    'http_req_failed{scenario:cache_miss}': ['rate<0.05'],
    'http_req_duration{scenario:cache_hit}':  ['p(95)<500'],
    'http_req_duration{scenario:cache_miss}': ['p(95)<500'],
    // Acima da cota: todo 429 tem Retry-After e nada além de 200 e 429 aparece (nenhum 5xx).
    // Exigir pelo menos um 429 aqui seria não determinístico: o limitador usa janela fixa de 1 min
    // e o serviço atende o pico sem passar de 6.000 req na mesma janela se ela virar no meio.
    // O 429 é provado por tests/load/limite-429.js, com o limite baixado por RATE_LIMIT_MAX.
    pico_429_sem_retry_after:  ['rate==0'],
    pico_respostas_outras:     ['count==0'],
  },
};

/**
 * setup() roda UMA VEZ antes de todos os cenários.
 *   1. Token OAuth2 (client credentials) no Keycloak
 *   2. Seed 10 lançamentos em TEST_DATE (cenário cache_hit)
 *   3. Seed 1 lançamento por data em CACHE_MISS_DATES (cenário cache_miss)
 *   4. Aguarda 7s de consistência eventual
 *   5. Verifica TEST_DATE retorna 200 (pré-condição cache_hit)
 *   6. Verifica amostra das datas cache_miss — apenas 2, sem aquecer as outras 58
 *      (o TTL de 60s expira antes de T=70s quando cache_miss inicia)
 */
export function setup() {
  // ── 1. Token no Keycloak ─────────────────────────────────────────────────────
  // Vale 300 s, mais que o teste inteiro. O comerciante é o da credencial (loja-1).
  const tokenRes = http.post(
    `${KEYCLOAK_URL}/realms/caixa/protocol/openid-connect/token`,
    { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
  );
  if (tokenRes.status !== 200) {
    throw new Error(`[setup] Token no Keycloak falhou: HTTP ${tokenRes.status} ${tokenRes.body}`);
  }
  const token = tokenRes.json('access_token');
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // ── 2. Seed cache_hit ────────────────────────────────────────────────────────
  console.log(`[setup] Populando ${TEST_DATE} (cache_hit)...`);
  for (let i = 0; i < 10; i++) {
    const res = http.post(
      `${LANCAMENTOS_URL}/lancamentos`,
      JSON.stringify({
        valor: (100 + i * 10).toFixed(2),
        tipo: i % 2 === 0 ? 'credito' : 'debito',
        descricao: `seed-hit-${i}`,
        data: TEST_DATE,
      }),
      { headers: authHeaders },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`[setup] Seed cache_hit #${i} falhou: HTTP ${res.status} — ${res.body}`);
    }
  }

  // ── 3. Seed cache_miss (60 datas) ────────────────────────────────────────────
  console.log(`[setup] Populando ${CACHE_MISS_DATES.length} datas (cache_miss)...`);
  for (let i = 0; i < CACHE_MISS_DATES.length; i++) {
    const res = http.post(
      `${LANCAMENTOS_URL}/lancamentos`,
      JSON.stringify({
        valor: (200 + i).toFixed(2),
        tipo: 'credito',
        descricao: `seed-miss-${i}`,
        data: CACHE_MISS_DATES[i],
      }),
      { headers: authHeaders },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(
        `[setup] Seed cache_miss #${i} (${CACHE_MISS_DATES[i]}) falhou: HTTP ${res.status} — ${res.body}`,
      );
    }
  }

  // ── 4. Propagação eventual ───────────────────────────────────────────────────
  console.log('[setup] Aguardando propagação (SLA ≤ 5s; margem: 7s)...');
  sleep(7);

  // ── 5. Pré-condição cache_hit ────────────────────────────────────────────────
  const verifyHit = http.get(
    `${CONSOLIDADO_URL}/consolidado/${TEST_DATE}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (verifyHit.status !== 200) {
    throw new Error(
      `[setup] Pré-condição cache_hit falhou: ${TEST_DATE} retornou HTTP ${verifyHit.status}`,
    );
  }
  console.log(`[setup] cache_hit OK → ${verifyHit.body.substring(0, 120)}`);

  // ── 6. Pré-condição cache_miss (amostra: 1ª e última data) ────────────────────
  // Verifica apenas 2 datas para confirmar propagação sem aquecer as outras 58.
  // O TTL de 60s expira antes de T=70s, portanto todas as 60 datas estarão
  // frias (cache miss) quando o cenário cache_miss iniciar.
  for (const sampleDate of [CACHE_MISS_DATES[0], CACHE_MISS_DATES[CACHE_MISS_DATES.length - 1]]) {
    const verifyMiss = http.get(
      `${CONSOLIDADO_URL}/consolidado/${sampleDate}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (verifyMiss.status !== 200) {
      throw new Error(
        `[setup] Pré-condição cache_miss falhou: ${sampleDate} retornou HTTP ${verifyMiss.status}`,
      );
    }
    console.log(`[setup] cache_miss sample OK → ${sampleDate}: ${verifyMiss.body.substring(0, 80)}`);
  }

  return { token };
}

/** Cenário 1: cache quente — DATA FIXA → Redis hit após 1ª requisição */
export function cacheHitScenario(data) {
  const res = http.get(
    `${CONSOLIDADO_URL}/consolidado/${TEST_DATE}`,
    { headers: { Authorization: `Bearer ${data.token}` } },
  );
  const isOk = res.status === 200;
  nonOkRate.add(!isOk);
  check(res, {
    'HTTP 200': r => r.status === 200,
    'latência < 500ms': r => r.timings.duration < 500,
  });
}

/** Cenário 2: cache miss — DATA VARIÁVEL → rotação entre 60 datas distintas */
export function cacheMissScenario(data) {
  const date = CACHE_MISS_DATES[exec.scenario.iterationInTest % CACHE_MISS_DATES.length];
  const res = http.get(
    `${CONSOLIDADO_URL}/consolidado/${date}`,
    { headers: { Authorization: `Bearer ${data.token}` } },
  );
  const isOk = res.status === 200;
  nonOkRate.add(!isOk);
  check(res, {
    'HTTP 200': r => r.status === 200,
    'latência < 500ms': r => r.timings.duration < 500,
  });
}

/** Cenário 3: acima da cota do limitador. 200 e 429 são esperados; qualquer outro status é falha. */
export function picoScenario(data) {
  const res = http.get(
    `${CONSOLIDADO_URL}/consolidado/${TEST_DATE}`,
    {
      headers: { Authorization: `Bearer ${data.token}` },
      responseCallback: http.expectedStatuses(200, 429),
    },
  );
  if (res.status === 200) {
    pico200.add(1);
  } else if (res.status === 429) {
    pico429.add(1);
    picoSemRetryAfter.add(!res.headers['Retry-After']);
  } else {
    picoOutros.add(1);
  }
}

// k6 requer default export; não é chamado quando todos os cenários usam exec: explícito.
export default function () {}
