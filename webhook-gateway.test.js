'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { createGateway } = require('./webhook-gateway');

const beforeSHA = 'a'.repeat(40);
const afterSHA = 'b'.repeat(40);
let upstream;
let gateway;
let upstreamRequests = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function request(path, { method = 'POST', event = 'push', body = '', headers = {}, server = gateway } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: { 'x-github-event': event, 'content-length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function payload(overrides = {}) {
  return JSON.stringify({ ref: 'refs/heads/main', before: beforeSHA, after: afterSHA, ...overrides });
}

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamRequests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(204);
      res.end();
    });
  });
  await listen(upstream);
  gateway = createGateway(new URL(`http://127.0.0.1:${upstream.address().port}`));
  await listen(gateway);
});

after(async () => {
  await Promise.all([
    new Promise((resolve) => gateway.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
  ]);
});

test('forwards a main push and preserves its signed body and signature', async () => {
  upstreamRequests = [];
  const body = `  ${payload()}\n`;
  const result = await request('/v1/webhook?source=github', {
    body,
    headers: { 'x-hub-signature-256': 'sha256=example' },
  });
  assert.equal(result.status, 204);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].path, '/v1/webhook?source=github');
  assert.equal(upstreamRequests[0].body, body);
  assert.equal(upstreamRequests[0].headers['x-hub-signature-256'], 'sha256=example');
});

test('filters non-main, unchanged, deleted, malformed and non-push events', async () => {
  upstreamRequests = [];
  const cases = [
    { body: payload({ ref: 'refs/heads/renovate/grafana-monorepo' }) },
    { body: payload({ ref: 'refs/tags/main' }) },
    { body: payload({ before: afterSHA }) },
    { body: payload({ after: '0'.repeat(40) }) },
    { body: payload({ after: 'not-a-commit' }) },
    { body: payload(), event: 'create' },
    { body: payload(), method: 'GET' },
  ];
  for (const options of cases) assert.equal((await request('/v1/webhook', options)).status, 202);
  assert.equal((await request('/v1/webhook', { body: '{' })).status, 400);
  assert.equal(upstreamRequests.length, 0);
});

test('filters custom webhook targets and rejects non-canonical bypass paths', async () => {
  upstreamRequests = [];
  assert.equal((await request('/v1/webhook/custom', { body: payload({ ref: 'refs/heads/other' }) })).status, 202);
  for (const path of ['/v1/%77ebhook', '/v1//webhook', '/v1/x/../webhook', '/v1\\webhook']) {
    assert.equal((await request(path, { body: payload() })).status, 400);
  }
  assert.equal(upstreamRequests.length, 0);
});

test('allows an initial main push and proxies other endpoints unchanged', async () => {
  upstreamRequests = [];
  assert.equal((await request('/v1/webhook', { body: payload({ before: '0'.repeat(40) }) })).status, 204);
  assert.equal((await request('/v1/webhook/custom', { body: payload() })).status, 204);
  assert.equal((await request('/v1/api/projects?all=true', { method: 'GET' })).status, 204);
  assert.equal(upstreamRequests.length, 3);
  assert.equal(upstreamRequests[2].path, '/v1/api/projects?all=true');
});

test('rejects oversized webhook payloads without forwarding', async () => {
  upstreamRequests = [];
  const result = await request('/v1/webhook', { body: 'x'.repeat(10 * 1024 * 1024 + 1) });
  assert.equal(result.status, 413);
  assert.equal(upstreamRequests.length, 0);
});

test('reports an unavailable upstream as an error', async () => {
  const unavailable = http.createServer();
  await listen(unavailable);
  const port = unavailable.address().port;
  await new Promise((resolve) => unavailable.close(resolve));
  const isolated = createGateway(new URL(`http://127.0.0.1:${port}`));
  await listen(isolated);
  try {
    assert.equal((await request('/v1/webhook', { body: payload(), server: isolated })).status, 502);
  } finally {
    await new Promise((resolve) => isolated.close(resolve));
  }
});
