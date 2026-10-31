'use strict';

const crypto = require('node:crypto');
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
const injectTemplate = fs.readFileSync(path.join(__dirname, 'cli-inject.html'), 'utf8');
const networkTemplate = fs.readFileSync(path.join(__dirname, 'cli-network.html'), 'utf8');
const networkChild = fs.readFileSync(path.join(__dirname, 'cli-network-child.html'), 'utf8');
const storageTemplate = fs.readFileSync(path.join(__dirname, 'cli-storage.html'), 'utf8');
const storageChild = fs.readFileSync(path.join(__dirname, 'cli-storage-child.html'), 'utf8');
const storageApp = fs.readFileSync(path.join(__dirname, 'cli-storage-app.js'), 'utf8');
const fixture = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
// One line, so the used and unused lengths in the acceptance are exact.
const PROFILE_CSS =
  '.profile-used{font-weight:bold}.profile-unused-a{color:green}.profile-unused-b{margin:3px}';
const PROFILE_FILES = {
  '/profile': ['text/html', fixture('cli-profile.html')],
  '/profile-child': ['text/html', fixture('cli-profile-child.html')],
  '/profile-app.js': ['text/javascript', fixture('cli-profile-app.js')],
  '/profile-worker.js': ['text/javascript', fixture('cli-profile-worker.js')],
  '/profile.css': ['text/css', PROFILE_CSS],
};

// One-line ~300 KB bundle with non-ASCII text, so source paging crosses byte and code-unit limits.
function scriptsBundle() {
  const parts = [];
  for (let index = 0; index < 6000; index += 1) {
    parts.push('function m' + index + '(a){return a*' + index + '+"汉字' + (index % 10) + '"}');
  }
  parts.push('window.bundleMarker="bundle-' + runId + '"');
  return parts.join(';') + '\n//# sourceMappingURL=scripts-bundle.js.map\n';
}
const analysisFixture = (name) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'analysis', '__fixtures__', name), 'utf8');
// The webpack bundle and its map come from the analysis unit fixtures; nomap.js carries a JWT for
// the redaction check; badmap.js points at a map that is not served.
const ANALYSIS_FILES = {
  '/analysis': ['text/html', fixture('cli-analysis.html')],
  '/analysis/webpack-prod.js': ['text/javascript', analysisFixture('webpack-prod.js')],
  '/analysis/webpack-prod.js.map': ['application/json', analysisFixture('webpack-prod.js.map')],
  '/analysis/nomap.js': [
    'text/javascript',
    'window.analysisToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZWIiLCJleHAiOjQxMDI0NDQ4MDB9.c2lnbmF0dXJlLWJ5dGVz";\n' +
      'window.analysisRun = "' +
      runId +
      '";\n',
  ],
  '/analysis/badmap.js': [
    'text/javascript',
    'window.analysisBad = 1;\n//# sourceMappingURL=missing.js.map\n',
  ],
};
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
  if (url.pathname === '/inject-api' && ['GET', 'POST'].includes(request.method)) {
    response.writeHead(request.method === 'POST' ? 201 : 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/net') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      networkTemplate
        .replaceAll('@@RUN_ID@@', runId)
        .replaceAll('@@CROSS_ORIGIN@@', 'http://localhost:' + server.address().port),
    );
    return;
  }
  if (request.method === 'GET' && ['/storage', '/storage-child'].includes(url.pathname)) {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      url.pathname === '/storage-child'
        ? storageChild
        : storageTemplate
            .replaceAll('@@RUN_ID@@', runId)
            .replaceAll('@@CROSS_ORIGIN@@', 'http://localhost:' + server.address().port),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/storage-app.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(storageApp);
    return;
  }
  if (request.method === 'GET' && Object.hasOwn(ANALYSIS_FILES, url.pathname)) {
    const [type, body] = ANALYSIS_FILES[url.pathname];
    response.writeHead(200, {
      'Content-Type': type + '; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(body);
    return;
  }
  const profileFile =
    request.method === 'GET' && Object.hasOwn(PROFILE_FILES, url.pathname)
      ? PROFILE_FILES[url.pathname]
      : undefined;
  if (profileFile) {
    response.writeHead(200, {
      'Content-Type': profileFile[0] + '; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      profileFile[1].replaceAll('@@CROSS_ORIGIN@@', 'http://localhost:' + server.address().port),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/net-child') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(networkChild);
    return;
  }
  if (url.pathname === '/net-api' && ['GET', 'POST'].includes(request.method)) {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const kind = url.searchParams.get('kind') || '';
      const headers = { 'Cache-Control': 'no-store', 'X-Run': runId };
      if (kind === 'binary') {
        const bytes = Buffer.alloc(1024);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
        response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' });
        response.end(bytes);
        return;
      }
      if (kind === 'big') {
        // Larger than a default 1 MB body limit, in multi-byte text.
        response.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('汉'.repeat(700_000));
        return;
      }
      response.writeHead(request.method === 'POST' ? 201 : 200, {
        ...headers,
        'Content-Type': 'application/json',
        'Set-Cookie': 'net_session=hidden-' + runId + '; Path=/; HttpOnly',
      });
      response.end(
        JSON.stringify({
          kind,
          method: request.method,
          body: Buffer.concat(chunks).toString('utf8'),
          trace: request.headers['x-trace'] || null,
          run: runId,
        }),
      );
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/net-sse') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      response.write('event: tick\nid: ' + count + '\ndata: tick-' + count + '-' + runId + '\n\n');
      if (count === 3) {
        clearInterval(timer);
        response.end();
      }
    }, 50);
    request.on('close', () => clearInterval(timer));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/inject') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Document-start injection goes through CDP and must not need 'unsafe-eval'.
      'Content-Security-Policy': "script-src 'self' 'unsafe-inline'",
    });
    response.end(
      injectTemplate
        .replaceAll('@@RUN_ID@@', runId)
        .replaceAll('@@CROSS_ORIGIN@@', 'http://localhost:' + server.address().port),
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

// Minimal RFC 6455 echo for /net-ws: unfragmented frames under 64 KB, enough for the fixture.
const sockets = new Set();
function wsFrame(opcode, payload) {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, payload]);
}
server.on('upgrade', (request, socket) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const key = request.headers['sec-websocket-key'];
  if (url.pathname !== '/net-ws' || typeof key !== 'string') {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n',
  );
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 0x8) {
        socket.end(wsFrame(0x8, payload.subarray(0, 2)));
        return;
      }
      if (opcode === 0x1)
        socket.write(wsFrame(0x1, Buffer.from('echo:' + payload.toString('utf8'))));
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server failed to bind');
  process.send({ type: 'ready', port: address.port });
});

function close() {
  for (const socket of sockets) socket.destroy();
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
