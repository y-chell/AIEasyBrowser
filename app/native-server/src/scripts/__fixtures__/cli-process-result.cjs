'use strict';

const mode = process.argv[2];
if (mode === 'success') {
  process.stdout.write(JSON.stringify({ ok: true, result: { fixture: true } }) + '\n');
} else if (mode === 'failure') {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'FIXTURE_FAILURE' } }) + '\n');
  process.exitCode = 3;
} else if (mode === 'invalid-json') {
  process.stdout.write('not-json\n');
} else {
  process.stderr.write('unknown fixture mode\n');
  process.exitCode = 2;
}
