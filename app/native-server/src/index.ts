#!/usr/bin/env node
import { getServerInstance } from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { logger, probeLogWritable } from './util/diag-log';

// Logging must be ready before anything that can fail during construction.
const writable = probeLogWritable();
if (writable.ok) {
  logger.info({ event: 'process.start' });
} else {
  process.stderr.write(
    `[aieasybrowser] log directory is not writable: ${writable.path} (${writable.error ?? 'unknown error'})\n`,
  );
}

try {
  const serverInstance = getServerInstance(); // May throw on invalid AIEASYBROWSER_HOST
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  nativeMessagingHostInstance.start();
  logger.info({ event: 'process.ready' });
} catch (error) {
  logger.error({
    event: 'process.start_failed',
    errorName: error instanceof Error ? error.name : undefined,
  });
  process.exit(1);
}

process.on('error', (error) => {
  logger.error({ event: 'process.error', errorName: error.name });
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  logger.info({ event: 'process.signal', signal: 'SIGINT' });
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info({ event: 'process.signal', signal: 'SIGTERM' });
  process.exit(0);
});

process.on('exit', (code) => {
  logger.info({ event: 'process.exit', exitCode: code });
});

process.on('uncaughtException', (error) => {
  logger.error({ event: 'process.uncaught_exception', errorName: error.name });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
  logger.error({
    event: 'process.unhandled_rejection',
    errorName: reason instanceof Error ? reason.name : undefined,
  });
});
