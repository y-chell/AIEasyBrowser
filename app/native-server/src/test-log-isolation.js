/* global afterAll */
/**
 * Point every test suite at a throwaway log directory.
 *
 * Command, route and server tests exercise the real request paths, so without this
 * they append synthetic records (including fixture failures) to the user's log file
 * under %LOCALAPPDATA%. Isolation belongs here rather than in each suite because a
 * new test that happens to call a logged path would silently pollute again.
 *
 * AIEASYBROWSER_LOG_DIR is read by diag-log on every write, so setting it before the
 * suite imports anything is enough; no module mocking is needed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieasybrowser-jest-log-'));
process.env.AIEASYBROWSER_LOG_DIR = logDir;

afterAll(() => {
  if (path.dirname(resolveReal(logDir)) === path.resolve(os.tmpdir())) {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

function resolveReal(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
