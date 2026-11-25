'use strict';

const http = require('node:http');

const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;
const ZERO_COMMIT = '0'.repeat(40);

function respond(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

function forward(req, res, upstream, body) {
  const headers = { ...req.headers, host: upstream.host };
  const proxy = http.request({
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers,
  }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  proxy.on('error', (error) => {
    console.error('Doco-CD proxy error:', error.message);
    if (!res.headersSent) respond(res, 502, 'Doco-CD unavailable');
    else res.destroy(error);
  });
  req.on('aborted', () => proxy.destroy());
  if (body === undefined) req.pipe(proxy);
  else proxy.end(body);
}

function createGateway(upstream = new URL('http://doco-cd:80')) {
  return http.createServer((req, res) => {
    req.on('error', (error) => {
      console.error('Request error:', error.message);
      if (!res.headersSent) respond(res, 400, 'Request failed');
      else res.destroy(error);
    });
    const path = req.url.split('?', 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      respond(res, 400, 'Invalid request path');
      return;
    }

    // Reject alternate paths rather than letting an upstream router normalize
    // them into a webhook endpoint without passing the filter.
    if (path !== decoded || path.includes('//') || path.includes('\\') ||
        path.split('/').some((part) => part === '.' || part === '..')) {
      respond(res, 400, 'Non-canonical request path');
      return;
    }

    if (path !== '/v1/webhook' && !path.startsWith('/v1/webhook/')) {
      forward(req, res, upstream);
      return;
    }
    if (req.method !== 'POST' || req.headers['x-github-event'] !== 'push') {
      respond(res, 202, 'Webhook ignored: only GitHub push events are accepted');
      req.resume();
      return;
    }

    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) {
        if (!tooLarge) respond(res, 413, 'Webhook payload too large');
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        respond(res, 400, 'Invalid webhook JSON');
        return;
      }
      if (!payload || payload.ref !== 'refs/heads/main' ||
          typeof payload.before !== 'string' || !COMMIT.test(payload.before) ||
          typeof payload.after !== 'string' || !COMMIT.test(payload.after) ||
          payload.after === ZERO_COMMIT || payload.before === payload.after) {
        respond(res, 202, 'Webhook ignored: no main branch change');
        return;
      }
      forward(req, res, upstream, body);
    });
  });
}

if (require.main === module) {
  createGateway().listen(8080, '0.0.0.0', () => {
    console.log('Webhook gateway listening on port 8080');
  });
}

module.exports = { createGateway };
