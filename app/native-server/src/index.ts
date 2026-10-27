#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { logger, probeLogWritable, sanitizeText } from './util/diag-log';

const writable = probeLogWritable();
if (writable.ok) {
  logger.info({ event: 'process.start', port: undefined, extra: { logPath: writable.path } });
} else {
  // Startup must not pretend logging works: say where it failed and keep going,
  // because a broken log directory must not take the browser bridge down with it.
  process.stderr.write(
    `[aieasybrowser] log directory is not writable: ${writable.path} (${sanitizeText(writable.error ?? 'unknown error')})\n`,
  );
}

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  nativeMessagingHostInstance.start();
  logger.info({ event: 'process.ready' });
} catch (error) {
  logger.error({
    event: 'process.start_failed',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

process.on('error', (error) => {
  logger.error({ event: 'process.error', error: error.message });
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  logger.info({ event: 'process.signal', extra: { signal: 'SIGINT' } });
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info({ event: 'process.signal', extra: { signal: 'SIGTERM' } });
  process.exit(0);
});

process.on('exit', (code) => {
  logger.info({ event: 'process.exit', code: String(code) });
});

process.on('uncaughtException', (error) => {
  logger.error({ event: 'process.uncaught_exception', error: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
  logger.error({
    event: 'process.unhandled_rejection',
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
