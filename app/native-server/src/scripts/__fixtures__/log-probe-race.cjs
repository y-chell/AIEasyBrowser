'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const log = require('../../../dist/util/diag-log');
const modulePath = require.resolve('../../../dist/util/diag-log');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-probe-race-'));
const target = path.join(dir, log.LOG_FILE_NAME);
const rename = fs.renameSync;
function writeFromChild() {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const log = require(${JSON.stringify(modulePath)});
    log.setLogDirForTests(${JSON.stringify(dir)});
    const error = log.logger.info({ event: 'CONCURRENT_RECORD' });
    process.stdout.write(JSON.stringify({ error: error?.message ?? null }));
  `,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
try {
  log.setLogDirForTests(dir);
  fs.writeFileSync(target, 'OLD_RECORD\n');
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && String(from).includes('.rename-probe-') && String(to) === target) {
      injected = true;
      // The actual logger in another process must not recreate the moved live path.
      assert.match(writeFromChild().error, /log lock busy/);
      assert.equal(fs.existsSync(target), false);
    }
    return rename(from, to);
  };
  const probe = log.probeLogWritable();
  assert.equal(probe.ok, true, probe.error);
  assert.equal(writeFromChild().error, null);
  const retained = fs.readFileSync(target, 'utf8').includes('CONCURRENT_RECORD');
  assert(fs.readFileSync(target, 'utf8').startsWith('OLD_RECORD\n'));
  assert.equal(fs.existsSync(target + '.lock'), false);
  process.stdout.write(
    JSON.stringify({
      probeOk: probe.ok,
      concurrentWriteRejected: injected,
      retriedRecordRetained: retained,
    }) + '\n',
  );
  assert(injected, 'fixture did not reach the intended race boundary');
  assert(retained, 'doctor discarded a concurrent log record');
} finally {
  fs.renameSync = rename;
  log.setLogDirForTests(undefined);
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('aieasybrowser-probe-race-'));
  process.stderr.write('Cleaning isolated fixture: ' + path.resolve(dir) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
}
