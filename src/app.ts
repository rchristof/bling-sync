const crypto = require('crypto');
const express = require('express');
const { APP_NAME, BLING_CLIENT_ID, BLING_OAUTH_BASE_URL, PORT } = require('./config');
const { pool } = require('./db');
const { exchangeAuthorizationCode, loadToken } = require('./oauth');
const { log } = require('./logger');
const { enqueueWebhook, verifyBlingSignature } = require('./webhooks');

function createApp() {
  const app = express();

  app.use(express.json({
    limit: process.env.JSON_BODY_LIMIT || '5mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));

  app.use((req, res, next) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', requestId);
    const started = Date.now();

    res.on('finish', () => {
      log('info', 'http request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });

    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', app: APP_NAME, uptime: process.uptime() });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      log('error', 'readiness check failed', { error: err.message });
      res.status(503).json({ status: 'error', error: err.message });
    }
  });

  app.get('/auth', (_req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const url = new URL(`${BLING_OAUTH_BASE_URL}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', BLING_CLIENT_ID);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/status', async (_req, res) => {
    try {
      const token = await loadToken();
      const expiresAt = token?.expires_at ? new Date(token.expires_at) : null;

      res.json({
        hasToken: Boolean(token),
        hasAccessToken: Boolean(token?.access_token),
        hasRefreshToken: Boolean(token?.refresh_token),
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        isExpired: expiresAt ? Date.now() >= expiresAt.getTime() : null,
      });
    } catch (err) {
      log('error', 'auth status check failed', { error: err.message });
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  const handleOAuthCallback = async (req, res) => {
    try {
      if (req.query.error) {
        res.status(400).send(`Bling authorization error: ${req.query.error_description || req.query.error}`);
        return;
      }

      if (!req.query.code) {
        res.status(400).send('Missing authorization code');
        return;
      }

      await exchangeAuthorizationCode(req.query.code);
      res.send('Bling authorization finished. Token saved.');
    } catch (err) {
      log('error', 'oauth callback failed', { error: err.message });
      res.status(500).send(err.message);
    }
  };

  app.get('/callback', handleOAuthCallback);
  app.get('/auth/callback', handleOAuthCallback);

  app.post('/webhooks/bling', async (req, res) => {
    const signature = req.headers['x-bling-signature-256'];

    if (!verifyBlingSignature(req.rawBody, signature)) {
      log('warn', 'webhook signature invalid', {
        hasSignature: Boolean(signature),
        ip: req.ip,
      });
      res.status(401).json({ status: 'unauthorized' });
      return;
    }

    try {
      await enqueueWebhook(req.body, req.headers, req.rawBody);
    } catch (err) {
      log('error', 'webhook enqueue failed', {
        error: err.message,
        event: req.body?.event,
        eventId: req.body?.eventId,
      });
      res.status(500).json({ status: 'error' });
      return;
    }

    res.status(202).json({ status: 'accepted' });
  });

  app.use((err, req, res, _next) => {
    log('error', 'unhandled http error', {
      error: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
    });
    if (res.headersSent) return;
    res.status(500).json({ status: 'error', error: err.message });
  });

  return app;
}

function listen(app) {
  return app.listen(PORT, () => {
    log('info', 'server started', { port: PORT });
  });
}

module.exports = { createApp, listen };
