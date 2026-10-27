#!/usr/bin/env node

import { program, CommanderError } from 'commander';
import {
  tryRegisterUserLevelHost,
  colorText,
  ensureExecutionPermissions,
  writeNodePathFile,
} from './scripts/utils';
import { BrowserType, parseBrowserType } from './scripts/browser-config';
import { runDoctor } from './scripts/doctor';
import { runReport } from './scripts/report';
import { registerBrowserCommands, BROWSER_COMMAND_NAMES, browserExitCode } from './browser/cli';
import { BrowserCommandError, browserFailure } from './browser/protocol';

program
  .version(require('../package.json').version)
  .description('AIEasyBrowser - local service for communicating with the Chrome extension');

// Register Native Messaging host
program
  .command('register')
  .description('Register Native Messaging host')
  .option('-b, --browser <browser>', 'Register for specific browser (chrome, chromium, or all)')
  .action(async (options) => {
    try {
      // Write Node.js path for run_host scripts
      writeNodePathFile(__dirname);

      // Determine which browsers to register
      let targetBrowsers: BrowserType[] = [BrowserType.CHROME];

      if (options.browser) {
        if (options.browser.toLowerCase() === 'all') {
          targetBrowsers = [BrowserType.CHROME, BrowserType.CHROMIUM];
          console.log(colorText('Registering for all supported browsers...', 'blue'));
        } else {
          const browserType = parseBrowserType(options.browser);
          if (!browserType) {
            console.error(
              colorText(
                `Invalid browser: ${options.browser}. Use 'chrome', 'chromium', or 'all'`,
                'red',
              ),
            );
            process.exit(1);
          }
          targetBrowsers = [browserType];
        }
      }

      console.log(colorText('Registering user-level Native Messaging host...', 'blue'));
      const success = await tryRegisterUserLevelHost(targetBrowsers);
      if (!success) {
        throw new Error('User-level Native Messaging host registration failed');
      }
      console.log(colorText('Native Messaging host registered successfully!', 'green'));
    } catch (error: any) {
      console.error(colorText(`Registration failed: ${error.message}`, 'red'));
      process.exit(1);
    }
  });

// Fix execution permissions
program
  .command('fix-permissions')
  .description('Fix execution permissions for native host files')
  .action(async () => {
    try {
      console.log(colorText('Fixing execution permissions...', 'blue'));
      await ensureExecutionPermissions();
      console.log(colorText('✓ Execution permissions fixed successfully!', 'green'));
    } catch (error: any) {
      console.error(colorText(`Failed to fix permissions: ${error.message}`, 'red'));
      process.exit(1);
    }
  });

// Diagnose installation and environment issues
program
  .command('doctor')
  .description('Diagnose installation and environment issues')
  .option('--json', 'Output diagnostics as JSON')
  .option('--fix', 'Attempt to fix common issues automatically')
  .option('-b, --browser <browser>', 'Target browser (chrome, chromium, or all)')
  .action(async (options) => {
    try {
      const exitCode = await runDoctor({
        json: Boolean(options.json),
        fix: Boolean(options.fix),
        browser: options.browser,
      });
      process.exit(exitCode);
    } catch (error: any) {
      console.error(colorText(`Doctor failed: ${error.message}`, 'red'));
      process.exit(1);
    }
  });

// Export diagnostic report for GitHub Issues
program
  .command('report')
  .description('Export a diagnostic report for GitHub Issues')
  .option('--json', 'Output report as JSON (default: Markdown)')
  .option('--output <file>', 'Write report to file instead of stdout')
  .option('--copy', 'Copy report to clipboard')
  .option('--no-redact', 'Disable redaction of usernames/paths/tokens')
  .option('--include-logs <mode>', 'Include wrapper logs: none | tail | full', 'tail')
  .option('--log-lines <n>', 'Lines to include when --include-logs=tail', '200')
  .option('-b, --browser <browser>', 'Target browser (chrome, chromium, or all)')
  .action(async (options) => {
    try {
      const exitCode = await runReport({
        json: Boolean(options.json),
        output: options.output,
        copy: Boolean(options.copy),
        redact: options.redact,
        includeLogs: options.includeLogs,
        logLines: options.logLines ? parseInt(options.logLines, 10) : undefined,
        browser: options.browser,
      });
      process.exit(exitCode);
    } catch (error: any) {
      console.error(colorText(`Report failed: ${error.message}`, 'red'));
      process.exit(1);
    }
  });

registerBrowserCommands(program);

const browserInvocation = process.argv.slice(2).some((arg) => BROWSER_COMMAND_NAMES.has(arg));
program.exitOverride();
if (browserInvocation) program.configureOutput({ outputError: () => undefined });

async function main() {
  try {
    await program.parseAsync(process.argv);
    if (!process.argv.slice(2).length) program.outputHelp();
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    if (!browserInvocation && !(error instanceof BrowserCommandError)) {
      process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
      return;
    }
    const response = browserFailure(
      error instanceof BrowserCommandError ? error.code : 'INVALID_ARGUMENT',
      error instanceof Error ? error.message : String(error),
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exitCode = browserExitCode(response);
  }
}

void main();
