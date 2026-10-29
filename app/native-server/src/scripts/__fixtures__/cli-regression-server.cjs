'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const runId = process.argv[2];
const template = fs.readFileSync(path.join(__dirname, 'cli-regression.html'), 'utf8');
const longTemplate = fs.readFileSync(path.join(__dirname, 'cli-long-task.html'), 'utf8');
const frameTemplate = fs.readFileSync(path.join(__dirname, 'cli-long-frame.html'), 'utf8');
const scriptsTemplate = fs.readFileSync(path.join(__dirname, 'cli-scripts.html'), 'utf8');
const debuggerTemplate = fs.readFileSync(path.join(__dirname, 'cli-debugger.html'), 'utf8');
const debuggerApp = fs.readFileSync(path.join(__dirname, 'cli-debugger-app.js'), 'utf8');
const framesTemplate = fs.readFileSync(path.join(__dirname, 'cli-frames.html'), 'utf8');
const framesChild = fs.readFileSync(path.join(__dirname, 'cli-frames-child.html'), 'utf8');
const framesWorker = fs.readFileSync(path.join(__dirname, 'cli-frames-worker.js'), 'utf8');

// One-line ~300 KB bundle with non-ASCII text, so source paging crosses byte and code-unit limits.
function scriptsBundle() {
  const parts = [];
  for (let index = 0; index < 6000; index += 1) {
    parts.push('function m' + index + '(a){return a*' + index + '+"汉字' + (index % 10) + '"}');
  }
  parts.push('window.bundleMarker="bundle-' + runId + '"');
  return parts.join(';') + '\n//# sourceMappingURL=scripts-bundle.js.map\n';
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/scripts-bundle.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(scriptsBundle());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/debugger-app.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(debuggerApp.replaceAll('@@RUN_ID@@', runId));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/frames-worker.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(framesWorker.replaceAll('@@RUN_ID@@', runId));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/frames-child') {
    const name = (url.searchParams.get('name') || '').replace(/[^a-z0-9-]/gi, '');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      framesChild
        .replaceAll('@@NAME@@', name)
        .replaceAll(
          '@@NESTED@@',
          url.searchParams.get('nest') === '1'
            ? '<iframe id="nested" src="/frames-child?name=' + name + '-nested"></iframe>'
            : '',
        ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/frames') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // No 'unsafe-eval': evaluation through CDP must not depend on the page CSP.
      'Content-Security-Policy': "script-src 'self' 'unsafe-inline'",
    });
    response.end(
      framesTemplate
        .replaceAll('@@RUN_ID@@', runId)
        .replaceAll('@@CROSS_ORIGIN@@', 'http://localhost:' + server.address().port),
    );
    return;
  }
  if (
    request.method !== 'GET' ||
    !['/', '/long', '/long-frame', '/scripts', '/debugger'].includes(url.pathname)
  ) {
    if (request.method === 'GET' && url.pathname === '/signal') {
      const name = url.searchParams.get('name');
      if (!['timeout-start', 'timeout-end', 'disconnect-start', 'disconnect-end'].includes(name)) {
        response.writeHead(400).end('invalid signal');
        return;
      }
      if (process.connected) process.send({ type: 'signal', name });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end('not found');
    return;
  }
  const tag = url.searchParams.get('tag') || '';
  const escapeHtml = (value) =>
    value.replace(/[&<>"']/g, (character) => {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return entities[character];
    });
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(
    (url.pathname === '/long'
      ? longTemplate
      : url.pathname === '/long-frame'
        ? frameTemplate
        : url.pathname === '/scripts'
          ? scriptsTemplate
          : url.pathname === '/debugger'
            ? debuggerTemplate
            : template
    )
      .replaceAll('@@TAG@@', escapeHtml(tag))
      .replaceAll('@@RUN_ID@@', escapeHtml(runId))
      .replaceAll('@@FRAME_URL@@', 'http://localhost:' + server.address().port + '/long-frame'),
  );
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server failed to bind');
  process.send({ type: 'ready', port: address.port });
});

function close() {
  server.closeAllConnections();
  server.close(() => {
    if (process.connected) process.disconnect();
  });
}

process.on('message', (message) => {
  if (message?.type !== 'close') return;
  close();
});
process.on('disconnect', () => {
  if (server.listening) close();
});
