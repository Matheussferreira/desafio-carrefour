/**
 * Histórico longo: cerca de 3 anos de lançamentos diários de um comerciante (1095 dias).
 *
 * Mede o custo do saldo acumulado quando a soma percorre muitas linhas de saldo_diario.
 * O acumulado de cada data é a soma de todos os dias até ela, então a última data soma
 * 1095 linhas e a primeira soma uma.
 *
 *   historico_miss  consulta 1095 datas distintas a 50 req/s. Cada data é lida do banco pela
 *                   primeira vez (cache frio), então mede o caminho que soma as linhas.
 *   historico_hit   consulta sempre a última data a 50 req/s, já em cache, como contraponto.
 *
 * Cada resposta do cenário miss é conferida contra o acumulado calculado aqui, em centavos.
 *
 * Usa o comerciante loja-2 (erp-loja-2) para não misturar com os dados do teste principal.
 * Pode repetir: as chaves de idempotência evitam duplicar o histórico.
 *
 * Uso: docker compose --profile loadtest run --rm k6 run --summary-export=/evidencias/k6-historico-resumo.json /scripts/historico-longo.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import exec from 'k6/execution';

const LANCAMENTOS_URL = __ENV.LANCAMENTOS_URL || 'http://localhost:3001';
const CONSOLIDADO_URL = __ENV.CONSOLIDADO_URL || 'http://localhost:3002';
const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://localhost:8080';
const CLIENT_ID = __ENV.HIST_CLIENT_ID || 'erp-loja-2';
const CLIENT_SECRET = __ENV.HIST_CLIENT_SECRET || 'dev-segredo-erp-loja-2';
const DIAS = Number(__ENV.DIAS || 1095);
const INICIO = '2023-01-01';

const saldoIncorreto = new Rate('saldo_incorreto');

export const options = {
  setupTimeout: '300s',
  scenarios: {
    historico_miss: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: `${Math.ceil(DIAS / 50)}s`,
      preAllocatedVUs: 50,
      maxVUs: 150,
      exec: 'historicoMiss',
    },
    historico_hit: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 50,
      maxVUs: 150,
      startTime: `${Math.ceil(DIAS / 50) + 10}s`,
      exec: 'historicoHit',
    },
  },
  thresholds: {
    saldo_incorreto: ['rate==0'],
    'http_req_failed{scenario:historico_miss}': ['rate<0.05'],
    'http_req_failed{scenario:historico_hit}': ['rate<0.05'],
    'http_req_duration{scenario:historico_miss}': ['p(95)<500'],
    'http_req_duration{scenario:historico_hit}': ['p(95)<500'],
  },
};

function datas() {
  const lista = [];
  const d = new Date(`${INICIO}T00:00:00Z`);
  for (let i = 0; i < DIAS; i++) {
    lista.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return lista;
}

// Um crédito por dia e, a cada 5 dias, um débito. Valores em centavos para a conferência exata.
function movimento(i) {
  const credito = 10000 + (i % 7) * 250;
  const debito = i % 5 === 0 ? 4000 : 0;
  return { credito, debito };
}

const centavos = n => (n / 100).toFixed(2);

export function setup() {
  const tokenRes = http.post(`${KEYCLOAK_URL}/realms/caixa/protocol/openid-connect/token`, {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  if (tokenRes.status !== 200) throw new Error(`Token falhou: HTTP ${tokenRes.status} ${tokenRes.body}`);
  const token = tokenRes.json('access_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const lista = datas();
  const acumulados = [];
  let soma = 0;

  console.log(`[setup] Gravando ${DIAS} dias de histórico (${lista[0]} a ${lista[DIAS - 1]})...`);
  for (let i = 0; i < DIAS; i++) {
    const { credito, debito } = movimento(i);
    soma += credito - debito;
    acumulados.push(centavos(soma));

    const reqs = [
      ['POST', `${LANCAMENTOS_URL}/lancamentos`,
        JSON.stringify({ valor: centavos(credito), tipo: 'credito', data: lista[i], descricao: 'hist' }),
        { headers: Object.assign({}, headers, { 'X-Idempotency-Key': `hist-c-${lista[i]}` }) }],
    ];
    if (debito > 0) {
      reqs.push(['POST', `${LANCAMENTOS_URL}/lancamentos`,
        JSON.stringify({ valor: centavos(debito), tipo: 'debito', data: lista[i], descricao: 'hist' }),
        { headers: Object.assign({}, headers, { 'X-Idempotency-Key': `hist-d-${lista[i]}` }) }]);
    }
    for (const r of http.batch(reqs)) {
      if (r.status !== 201 && r.status !== 200) {
        throw new Error(`Seed de ${lista[i]} falhou: HTTP ${r.status} ${r.body}`);
      }
    }
    // O seed tem cerca de 1.300 requisições e o limite do serviço de lançamentos é 1.200 por minuto
    if (i % 100 === 99) sleep(6);
  }

  console.log('[setup] Aguardando o consolidado chegar ao saldo final esperado...');
  const ultima = lista[DIAS - 1];
  let ok = false;
  for (let t = 0; t < 180 && !ok; t++) {
    const r = http.get(`${CONSOLIDADO_URL}/consolidado/${ultima}`, { headers });
    ok = r.status === 200 && r.json('saldoAcumulado') === acumulados[DIAS - 1];
    if (!ok) sleep(1);
  }
  if (!ok) throw new Error('Consolidado não convergiu para o saldo final esperado');
  console.log(`[setup] Convergiu: saldo acumulado em ${ultima} = ${acumulados[DIAS - 1]}`);

  return { token, lista, acumulados };
}

export function historicoMiss(data) {
  const i = exec.scenario.iterationInTest % data.lista.length;
  const res = http.get(`${CONSOLIDADO_URL}/consolidado/${data.lista[i]}`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  const certo = res.status === 200 && res.json('saldoAcumulado') === data.acumulados[i];
  saldoIncorreto.add(!certo);
  check(res, { 'HTTP 200': r => r.status === 200 });
}

export function historicoHit(data) {
  const i = data.lista.length - 1;
  const res = http.get(`${CONSOLIDADO_URL}/consolidado/${data.lista[i]}`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  check(res, { 'HTTP 200': r => r.status === 200 });
}

export default function () {}
