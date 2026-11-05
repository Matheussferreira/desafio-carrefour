/**
 * Integração do outbox relay. Postgres e RabbitMQ reais.
 * Prova: nada é marcado como publicado sem confirmação do broker, e várias instâncias
 * concorrentes publicam cada evento exatamente uma vez.
 */
import { execFileSync } from 'child_process';
import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { CONSUMER_QUEUE, criarBroker } from '../../src/rabbitmq';
import { CanalPublicador, relayTick } from '../../src/relay/outboxRelay';

async function semear(quantidade: number): Promise<void> {
  await pool.query(
    `INSERT INTO outbox (id, tipo_evento, payload)
     SELECT id, 'LancamentoRegistrado', jsonb_build_object('eventoId', id, 'tipo', 'LancamentoRegistrado')
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, $1::int)) t`,
    [quantidade],
  );
}

async function contarPorStatus(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; n: string }>(
    'SELECT status, count(*) AS n FROM outbox GROUP BY status',
  );
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

const canalQueConfirma: CanalPublicador = {
  publish: (_e, _k, _c, _o, cb) => {
    setImmediate(() => cb(null));
    return true;
  },
};

beforeAll(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE outbox');
});

afterAll(async () => {
  await pool.end();
});

describe('confirmação do broker', () => {
  it('sem confirmação (nack), as linhas continuam pendentes', async () => {
    await semear(5);
    const canalQueRecusa: CanalPublicador = {
      publish: (_e, _k, _c, _o, cb) => {
        setImmediate(() => cb(new Error('nack do broker')));
        return true;
      },
    };

    await expect(relayTick({ pool, canal: canalQueRecusa })).rejects.toThrow('nack do broker');
    expect(await contarPorStatus()).toEqual({ pendente: 5 });
  });

  it('mensagem devolvida por falta de rota não é marcada como publicada', async () => {
    await semear(3);
    const devolvidas = new Set<string>();
    const canalSemRota: CanalPublicador = {
      publish: (_e, _k, _c, opts, cb) => {
        // o broker confirma, mas antes devolve a mensagem (evento "return")
        devolvidas.add(opts.messageId as string);
        setImmediate(() => cb(null));
        return true;
      },
    };

    await expect(relayTick({ pool, canal: canalSemRota, devolvidas })).rejects.toThrow('sem rota');
    expect(await contarPorStatus()).toEqual({ pendente: 3 });
  });

  it('com confirmação, marca como publicado e preenche published_at', async () => {
    await semear(5);

    expect(await relayTick({ pool, canal: canalQueConfirma })).toBe(5);

    expect(await contarPorStatus()).toEqual({ publicado: 5 });
    const { rows } = await pool.query('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('respeita o tamanho do lote', async () => {
    await semear(7);
    expect(await relayTick({ pool, canal: canalQueConfirma, tamanhoLote: 3 })).toBe(3);
    expect(await contarPorStatus()).toEqual({ pendente: 4, publicado: 3 });
  });

  it('pula as linhas que outro relay está publicando, sem esperar por elas (SKIP LOCKED)', async () => {
    await semear(10);
    const outroRelay = await pool.connect();
    try {
      // Outro relay no meio de uma publicação: segura as 4 linhas mais antigas
      await outroRelay.query('BEGIN');
      const { rows: travadas } = await outroRelay.query<{ id: string }>(
        "SELECT id FROM outbox WHERE status = 'pendente' ORDER BY created_at, id LIMIT 4 FOR UPDATE",
      );
      expect(travadas).toHaveLength(4);

      // Sem SKIP LOCKED este relay ficaria bloqueado nas linhas travadas até o outro terminar
      const publicados = await Promise.race([
        relayTick({ pool, canal: canalQueConfirma }),
        new Promise<number>((_, rejeitar) =>
          setTimeout(() => rejeitar(new Error('o relay ficou esperando linhas travadas por outro relay')), 3_000),
        ),
      ]);
      expect(publicados).toBe(6);

      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM outbox WHERE status = 'pendente' AND id = ANY($1::uuid[])",
        [travadas.map(r => r.id)],
      );
      expect(rows[0].n).toBe(4); // as travadas continuam pendentes, nenhuma foi publicada duas vezes
    } finally {
      await outroRelay.query('ROLLBACK');
      outroRelay.release();
    }
  });
});

describe('relays concorrentes contra o RabbitMQ real', () => {
  const TOTAL = 200;
  const RELAYS = 3;
  let leitor: ChannelModel;
  let canalLeitor: ConfirmChannel;
  const brokers = Array.from({ length: RELAYS }, () => criarBroker(config.rabbitmqUrl));

  async function aguardarConexao(): Promise<void> {
    const limite = Date.now() + 20_000;
    while (!brokers.every(b => b.isConnected())) {
      if (Date.now() > limite) throw new Error('RabbitMQ não conectou a tempo');
      await new Promise(r => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    brokers.forEach(b => b.start());
    await aguardarConexao();
    leitor = await amqp.connect(config.rabbitmqUrl);
    canalLeitor = await leitor.createConfirmChannel();
    await canalLeitor.purgeQueue(CONSUMER_QUEUE);
  }, 30_000);

  afterAll(async () => {
    // O teste de reconexão derruba todas as conexões, inclusive a do leitor
    try {
      await canalLeitor.purgeQueue(CONSUMER_QUEUE);
      await canalLeitor.close();
      await leitor.close();
    } catch {
      // conexão já encerrada
    }
    await Promise.all(brokers.map(b => b.close()));
  });

  it(`${RELAYS} relays em paralelo publicam ${TOTAL} eventos sem duplicar nem perder`, async () => {
    await semear(TOTAL);

    const rodar = async (i: number): Promise<number> => {
      const devolvidas = new Set<string>();
      brokers[i].getChannel().on('return', m => devolvidas.add(m.properties.messageId as string));
      let publicados = 0;
      for (let voltas = 0; voltas < 200; voltas++) {
        publicados += await relayTick({
          pool,
          canal: brokers[i].getChannel(),
          devolvidas,
          tamanhoLote: 20,
        });
        const { rows } = await pool.query("SELECT count(*) AS n FROM outbox WHERE status = 'pendente'");
        if (Number(rows[0].n) === 0) break;
      }
      return publicados;
    };

    const porRelay = await Promise.all(brokers.map((_, i) => rodar(i)));

    expect(porRelay.reduce((a, b) => a + b, 0)).toBe(TOTAL);
    expect(porRelay.filter(n => n > 0).length).toBeGreaterThan(1); // o trabalho foi de fato dividido
    expect(await contarPorStatus()).toEqual({ publicado: TOTAL });

    // Lê tudo o que chegou na fila e confere duplicidade pelo messageId
    const ids: string[] = [];
    for (let vazias = 0; ids.length < TOTAL && vazias < 50; ) {
      const msg = await canalLeitor.get(CONSUMER_QUEUE, { noAck: true });
      if (msg === false) {
        vazias++;
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      ids.push(msg.properties.messageId as string);
    }
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL);

    // E a fila não tem sobra
    expect((await canalLeitor.checkQueue(CONSUMER_QUEUE)).messageCount).toBe(0);
  }, 60_000);

  it('id de evento publicado coincide com o id da linha do outbox', async () => {
    const id = uuidv4();
    await pool.query("INSERT INTO outbox (id, tipo_evento, payload) VALUES ($1, 'LancamentoRegistrado', '{}')", [id]);

    await relayTick({ pool, canal: brokers[0].getChannel() });

    let msg = await canalLeitor.get(CONSUMER_QUEUE, { noAck: true });
    for (let i = 0; i < 30 && msg === false; i++) {
      await new Promise(r => setTimeout(r, 100));
      msg = await canalLeitor.get(CONSUMER_QUEUE, { noAck: true });
    }
    expect(msg).not.toBe(false);
    if (msg !== false) expect(msg.properties.messageId).toBe(id);
  });

  it('reconecta sozinho quando o broker derruba a conexão e volta a publicar', async () => {
    const container = process.env.RABBITMQ_IT_CONTAINER ?? 'desafio-as-it-rabbitmq-it-1';
    execFileSync('docker', ['exec', container, 'rabbitmqctl', 'close_all_connections', 'teste de reconexao']);

    const limiteQueda = Date.now() + 5_000;
    while (brokers[0].isConnected() && Date.now() < limiteQueda) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(brokers[0].isConnected()).toBe(false);

    await aguardarConexao();
    await pool.query('TRUNCATE outbox');
    await semear(4);
    expect(await relayTick({ pool, canal: brokers[0].getChannel() })).toBe(4);
    expect(await contarPorStatus()).toEqual({ publicado: 4 });
  }, 60_000);
});
