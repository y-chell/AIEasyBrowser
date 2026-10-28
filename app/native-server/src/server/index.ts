import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
  BRIDGE_ENV,
  getBridgeHost,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import {
  createHttpSecurityGuard,
  isLoopbackRemoteAddress,
  parseHttpSecurityConfig,
  type HttpSecurityConfig,
  type HttpSecurityGuard,
} from './http-security';
import { BrowserCommandService } from '../browser/command-service';
import { BrowserCommandError, browserFailure } from '../browser/protocol';
import { logger, startTimer } from '../util/diag-log';

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private readonly securityConfig: HttpSecurityConfig;
  private readonly securityGuard: HttpSecurityGuard;
  private readonly browserCommands = new BrowserCommandService(() => this.nativeHost);

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.securityConfig = parseHttpSecurityConfig({ listenHost: getBridgeHost() });
    this.securityGuard = createHttpSecurityGuard(this.securityConfig);
    this.setupPlugins();
    this.setupHealthRoutes();
    this.setupExtensionRoutes();
    this.setupBrowserRoutes();
  }

  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private setupPlugins(): void {
    this.fastify.addHook('onRequest', async (request, reply) => {
      if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
        reply
          .code(HTTP_STATUS.FORBIDDEN)
          .send(browserFailure('FORBIDDEN', 'Browser CLI is only available over loopback'));
      }
    });
    this.fastify.register(cors, {
      origin: (origin, cb) => cb(null, !origin || this.securityConfig.allowedOrigins.has(origin)),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      credentials: true,
    });
  }

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({ status: 'ok', message: 'pong' });
    });
  }

  private setupExtensionRoutes(): void {
    this.fastify.get('/ask-extension', async (request, reply) => {
      if (!this.nativeHost) {
        return reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
      }
      if (!this.isRunning) {
        return reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
      }
      try {
        const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
          request.query,
          'process_data',
          TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
        );
        return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
      } catch (error: unknown) {
        const err = error as Error;
        if (err.message.includes('timed out')) {
          return reply
            .status(HTTP_STATUS.GATEWAY_TIMEOUT)
            .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          status: 'error',
          message: `Failed to get response from extension: ${err.message}`,
        });
      }
    });
  }

  private setupBrowserRoutes(): void {
    this.fastify.post('/browser', { preHandler: this.securityGuard }, async (request, reply) => {
      const controller = new AbortController();
      const rawTimeout = (request.body as { timeoutMs?: unknown } | undefined)?.timeoutMs;
      const timeoutMs =
        typeof rawTimeout === 'number' &&
        Number.isInteger(rawTimeout) &&
        rawTimeout > 0 &&
        rawTimeout <= 120_000
          ? rawTimeout
          : 60_000;
      const elapsed = startTimer();
      const body = request.body as Record<string, unknown> | undefined;
      const session = typeof body?.session === 'string' ? body.session : 'default';
      const command = typeof body?.command === 'string' ? body.command : 'unknown';
      // Server-generated only. Client-supplied correlation ids would need a schema
      // field and would weaken strict request validation, so none is accepted.
      const requestId = randomUUID();
      const timer = setTimeout(
        () =>
          controller.abort(
            new BrowserCommandError('TIMEOUT', `Command timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
      const disconnected = () => {
        if (!reply.raw.writableEnded) {
          controller.abort(new BrowserCommandError('CANCELLED', 'CLI client disconnected'));
        }
      };
      reply.raw.once('close', disconnected);
      request.raw.once('aborted', disconnected);
      logger.info({
        event: 'command.start',
        requestId,
        session,
        tool: command,
        timeoutMs,
      });
      try {
        const response = await this.browserCommands.execute(
          request.body,
          controller.signal,
          requestId,
        );
        const status = response.ok
          ? 200
          : response.error?.code === 'INVALID_ARGUMENT'
            ? 400
            : response.error?.code === 'SESSION_BUSY'
              ? 409
              : response.error?.code === 'BRIDGE_UNAVAILABLE'
                ? 503
                : response.error?.code === 'TIMEOUT'
                  ? 504
                  : 422;
        logger[response.ok ? 'info' : 'warn']({
          event: response.ok ? 'command.ok' : 'command.failed',
          requestId,
          session,
          tool: command,
          durationMs: elapsed(),
          phase: response.phase,
          actionStatus: response.actionStatus,
          completed: response.completed,
          code: response.error?.code,
          status,
        });
        if (!reply.raw.destroyed) return reply.code(status).send(response);
      } catch (error) {
        logger.error({
          event: 'command.error',
          requestId,
          session,
          tool: command,
          durationMs: elapsed(),
          errorName: error instanceof Error ? error.name : undefined,
        });
        throw error;
      } finally {
        clearTimeout(timer);
        reply.raw.removeListener('close', disconnected);
        request.raw.removeListener('aborted', disconnected);
      }
    });
  }

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    this.nativeHost = nativeHost;
    if (this.isRunning) return;
    try {
      const address = await this.fastify.listen({ port, host: this.securityConfig.listenHost });
      process.env[BRIDGE_ENV.PORT] = new URL(address).port;
      this.isRunning = true;
      logger.info({
        event: 'bridge.started',
        port: Number(new URL(address).port),
      });
    } catch (error) {
      this.isRunning = false;
      logger.error({
        event: 'bridge.start_failed',
        port,
        errorName: error instanceof Error ? error.name : undefined,
      });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    try {
      await this.fastify.close();
      this.isRunning = false;
      logger.info({ event: 'bridge.stopped' });
    } catch (error) {
      this.isRunning = false;
      logger.error({
        event: 'bridge.stop_failed',
        errorName: error instanceof Error ? error.name : undefined,
      });
      throw error;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

/**
 * Construct lazily so a bad AIEASYBROWSER_HOST thrown by parseHttpSecurityConfig
 * happens inside the entry point's guarded startup, after logging is available,
 * instead of during module import.
 */
let serverInstance: Server | undefined;

export function getServerInstance(): Server {
  if (!serverInstance) serverInstance = new Server();
  return serverInstance;
}

export default getServerInstance;
