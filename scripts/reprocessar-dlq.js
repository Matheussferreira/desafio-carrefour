#!/usr/bin/env node
/**
 * Devolve as mensagens da DLQ à fila principal, pela API de gerenciamento do RabbitMQ.
 * Os wrappers reprocessar-dlq.ps1 e reprocessar-dlq.sh chamam este arquivo; precisa só do Node 20.
 *
 * Uso: node scripts/reprocessar-dlq.js [--limite N] [--simular] [--url URL] [--usuario U] [--senha S]
 *                                      [--dlq NOME] [--destino NOME]
 *
 * Reentregar é seguro: o consumidor é idempotente por eventoId. Mas uma mensagem inválida (JSON
 * quebrado, contrato 2.x) volta para a DLQ assim que o consumidor a recusar de novo; corrija a
 * causa antes. O script processa no máximo as mensagens que a DLQ tinha ao começar, então não
 * entra em laço com mensagens que continuam sendo recusadas.
 *
 * Cada mensagem é publicada na fila principal ANTES de a cópia da DLQ ser descartada. Se a
 * publicação não for confirmada, a mensagem volta para a DLQ e o script termina com erro.
 */

const args = process.argv.slice(2);
function opcao(nome, padrao) {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : padrao;
}

const URL_BASE = (opcao('url', process.env.RABBITMQ_MGMT_URL || 'http://localhost:15672')).replace(/\/$/, '');
const USUARIO = opcao('usuario', process.env.RABBITMQ_USER || 'rabbit');
const SENHA = opcao('senha', process.env.RABBITMQ_PASS || 'rabbit');
const DLQ = opcao('dlq', 'consolidado.lancamentos.dlq');
const DESTINO = opcao('destino', 'consolidado.lancamentos');
const LIMITE = Number(opcao('limite', '0')); // 0 = tudo
const SIMULAR = args.includes('--simular');
const VHOST = '%2F';
const AUTH = 'Basic ' + Buffer.from(`${USUARIO}:${SENHA}`).toString('base64');

async function api(metodo, caminho, corpo) {
  const res = await fetch(`${URL_BASE}/api${caminho}`, {
    method: metodo,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (!res.ok) throw new Error(`${metodo} ${caminho} respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const publicar = (fila, mensagem, cabecalhos) =>
  api('POST', `/exchanges/${VHOST}/amq.default/publish`, {
    properties: {
      delivery_mode: 2,
      ...(mensagem.properties.message_id ? { message_id: mensagem.properties.message_id } : {}),
      content_type: mensagem.properties.content_type || 'application/json',
      headers: cabecalhos,
    },
    routing_key: fila,
    payload: mensagem.payload,
    payload_encoding: 'base64',
  });

/** Tira o histórico de dead-letter, para a mensagem voltar como se fosse nova. Mantém o traceparent. */
function limparCabecalhos(h) {
  const saida = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (k === 'x-death' || k.startsWith('x-first-death') || k.startsWith('x-last-death')) continue;
    saida[k] = v;
  }
  return saida;
}

async function contar() {
  const fila = await api('GET', `/queues/${VHOST}/${encodeURIComponent(DLQ)}`);
  return fila.messages_ready ?? 0;
}

async function main() {
  const total = await contar();
  console.log(`DLQ ${DLQ}: ${total} mensagem(ns)`);
  if (total === 0) return 0;
  const alvo = LIMITE > 0 ? Math.min(LIMITE, total) : total;

  if (SIMULAR) {
    const amostra = await api('POST', `/queues/${VHOST}/${encodeURIComponent(DLQ)}/get`, {
      count: Math.min(alvo, 10),
      ackmode: 'ack_requeue_true',
      encoding: 'base64',
    });
    for (const m of amostra) {
      const corpo = Buffer.from(m.payload, 'base64').toString('utf8').slice(0, 120);
      console.log(`  ${m.properties.message_id || '(sem id)'}  ${corpo}`);
    }
    console.log(`Simulação: ${alvo} mensagem(ns) seriam devolvidas para ${DESTINO}. Nada foi alterado.`);
    return 0;
  }

  let devolvidas = 0;
  while (devolvidas < alvo) {
    const lote = await api('POST', `/queues/${VHOST}/${encodeURIComponent(DLQ)}/get`, {
      count: 1,
      ackmode: 'ack_requeue_false',
      encoding: 'base64',
    });
    if (lote.length === 0) break;
    const mensagem = lote[0];
    const cabecalhos = limparCabecalhos(mensagem.properties.headers);
    let roteada = false;
    try {
      roteada = (await publicar(DESTINO, mensagem, cabecalhos)).routed === true;
    } catch (err) {
      console.error(`Falha ao publicar em ${DESTINO}: ${err.message}`);
    }
    if (!roteada) {
      // Não perde a mensagem: devolve a cópia à DLQ e para
      await publicar(DLQ, mensagem, mensagem.properties.headers || {});
      console.error(`A fila ${DESTINO} não aceitou a mensagem. Ela foi devolvida à DLQ e o script parou.`);
      return 1;
    }
    devolvidas++;
  }
  console.log(`Devolvidas à fila ${DESTINO}: ${devolvidas}`);
  return 0;
}

main().then(
  codigo => process.exit(codigo),
  err => {
    console.error(`Erro: ${err.message}`);
    process.exit(2);
  },
);
