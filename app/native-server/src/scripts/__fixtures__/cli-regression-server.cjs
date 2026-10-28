'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const runId = process.argv[2];
const template = fs.readFileSync(path.join(__dirname, 'cli-regression.html'), 'utf8');
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'GET' || url.pathname !== '/') {
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
    template.replaceAll('@@TAG@@', escapeHtml(tag)).replaceAll('@@RUN_ID@@', escapeHtml(runId)),
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
