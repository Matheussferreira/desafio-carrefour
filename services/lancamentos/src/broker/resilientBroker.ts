import { EventEmitter } from 'events';
import amqp, { Channel, ChannelModel } from 'amqplib';
import type { Logger } from 'pino';
import { backoffDelay } from '../backoff';

export interface BrokerOptions<C extends Channel> {
  url: string;
  logger: Logger;
  criarCanal: (conexao: ChannelModel) => Promise<C>;
  preparar: (canal: C) => Promise<void>;
}

function comHeartbeat(url: string): string {
  const u = new URL(url);
  if (!u.searchParams.has('heartbeat')) u.searchParams.set('heartbeat', '15');
  return u.toString();
}

/**
 * Mantém uma conexão AMQP viva: reconecta com backoff quando cai e avisa por eventos.
 * Eventos: 'connected' (canal) e 'disconnected'.
 */
export class ResilientBroker<C extends Channel> extends EventEmitter {
  private conexao: ChannelModel | null = null;
  private canal: C | null = null;
  private tentativa = 0;
  private parado = false;
  private conectando = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BrokerOptions<C>) {
    super();
  }

  start(): void {
    void this.conectar();
  }

  isConnected(): boolean {
    return this.canal !== null;
  }

  getChannel(): C {
    if (!this.canal) throw new Error('RabbitMQ indisponível');
    return this.canal;
  }

  async close(): Promise<void> {
    this.parado = true;
    if (this.timer) clearTimeout(this.timer);
    const { canal, conexao } = this;
    this.canal = null;
    this.conexao = null;
    try {
      await canal?.close();
      await conexao?.close();
    } catch {
      // encerrando, a conexão pode já estar caída
    }
  }

  private async conectar(): Promise<void> {
    if (this.parado || this.conectando) return;
    this.conectando = true;
    const { logger } = this.opts;
    try {
      const conexao = await amqp.connect(comHeartbeat(this.opts.url));
      let canal: C;
      try {
        canal = await this.opts.criarCanal(conexao);
        await this.opts.preparar(canal);
      } catch (err) {
        await conexao.close().catch(() => undefined);
        throw err;
      }

      conexao.on('error', err => logger.error({ err }, 'Erro na conexão com o RabbitMQ'));
      conexao.on('close', () => this.aoCair(conexao));
      canal.on('error', err => logger.error({ err }, 'Erro no canal do RabbitMQ'));
      // Canal fechado com a conexão de pé (ex.: erro de protocolo): derruba a conexão para recomeçar limpo
      canal.on('close', () => {
        if (this.conexao === conexao) void conexao.close().catch(() => undefined);
      });

      this.conexao = conexao;
      this.canal = canal;
      this.tentativa = 0;
      logger.info('RabbitMQ conectado');
      this.emit('connected', canal);
    } catch (err) {
      logger.warn({ err, tentativa: this.tentativa + 1 }, 'RabbitMQ indisponível, nova tentativa agendada');
      this.agendar();
    } finally {
      this.conectando = false;
    }
  }

  private aoCair(conexao: ChannelModel): void {
    if (this.conexao !== conexao) return;
    this.conexao = null;
    this.canal = null;
    this.opts.logger.warn('Conexão com o RabbitMQ perdida');
    this.emit('disconnected');
    this.agendar();
  }

  private agendar(): void {
    if (this.parado) return;
    const espera = backoffDelay(this.tentativa++);
    this.timer = setTimeout(() => void this.conectar(), espera);
  }
}
