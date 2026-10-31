// Stand-in for worker.js in runner tests: the job kind picks the behaviour.
const { parentPort } = require('worker_threads');

parentPort.once('message', (job) => {
  if (job.kind === 'ok') parentPort.postMessage({ ok: true, value: { echo: job.text } });
  else if (job.kind === 'fail')
    parentPort.postMessage({ ok: false, code: 'PARSE_FAILED', detail: 'bad' });
  else if (job.kind === 'throw') throw new Error('worker blew up');
  else if (job.kind === 'exit') process.exit(3);
  else if (job.kind === 'hang') setInterval(() => {}, 1000);
});
