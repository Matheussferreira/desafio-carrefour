// Executa no Prometheus cada consulta do dashboard do Grafana e mostra quantas séries voltaram
// e o maior valor, para provar que os painéis têm dado. Uso: node scripts/verificar-dashboard.js [minutos]
const fs = require('fs');
const path = require('path');

const PROMETHEUS = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const MINUTOS = Number(process.argv[2] || 30);
const dashboard = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'observability', 'grafana', 'provisioning', 'dashboards', 'caixa-flow.json'), 'utf8'),
);

async function consultar(expr) {
  const fim = Math.floor(Date.now() / 1000);
  const url = `${PROMETHEUS}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${fim - MINUTOS * 60}&end=${fim}&step=15`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.error || 'consulta falhou');
  const series = j.data.result;
  let maximo = null;
  let amostras = 0;
  for (const s of series) {
    for (const [, v] of s.values) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        amostras++;
        maximo = maximo === null ? n : Math.max(maximo, n);
      }
    }
  }
  return { series: series.length, amostras, maximo };
}

(async () => {
  console.log(`Dashboard: ${dashboard.title}  |  janela: últimos ${MINUTOS} min  |  ${PROMETHEUS}`);
  console.log('');
  let vazios = 0;
  for (const painel of dashboard.panels) {
    if (!painel.targets) continue;
    for (const alvo of painel.targets) {
      const r = await consultar(alvo.expr);
      const ok = r.series > 0 && r.amostras > 0;
      if (!ok) vazios++;
      const max = r.maximo === null ? '-' : Number(r.maximo.toPrecision(4));
      console.log(`${ok ? 'COM DADO' : 'VAZIO   '}  painel ${String(painel.id).padStart(2)}  séries ${String(r.series).padStart(2)}  maior valor ${String(max).padStart(10)}  ${painel.title}`);
    }
  }
  console.log('');
  console.log(vazios === 0 ? 'Todos os painéis têm dado.' : `${vazios} consulta(s) sem dado.`);
  process.exit(vazios === 0 ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(2); });
