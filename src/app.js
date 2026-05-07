const crypto = require('crypto');
const express = require('express');
const { APP_NAME, BLING_OAUTH_BASE_URL, PORT, WEBHOOK_SECRET } = require('./config');
const { pool } = require('./db');
const { exchangeAuthorizationCode, loadToken } = require('./oauth');
const { log } = require('./logger');
const { runBackfill, runReconciliation } = require('./sync');
const { json, requiredEnv, valueOrNull } = require('./utils');
const { webhookEntityFromEvent } = require('./webhooks');

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
      res.status(503).json({ status: 'error', error: err.message });
    }
  });

  app.get('/auth', (_req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const url = new URL(`${BLING_OAUTH_BASE_URL}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', requiredEnv('BLING_CLIENT_ID'));
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
    if (WEBHOOK_SECRET) {
      const bearer = req.headers['authorization']?.replace(/^Bearer /i, '');
      const query = req.query?.secret;
      if (bearer !== WEBHOOK_SECRET && query !== WEBHOOK_SECRET) {
        res.status(401).json({ status: 'unauthorized' });
        return;
      }
    }

    const payload = req.body || {};
    const { resource, action } = webhookEntityFromEvent(payload.event);

    await pool.query(
      `INSERT INTO bling_webhook_events (
         event_id, event_name, resource, action, company_id, event_date,
         payload, headers, raw_body, received_at, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), 'pending')
       ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO UPDATE SET
         payload = EXCLUDED.payload,
         headers = EXCLUDED.headers,
         raw_body = EXCLUDED.raw_body
       RETURNING id`,
      [
        valueOrNull(payload.eventId),
        valueOrNull(payload.event),
        valueOrNull(resource),
        valueOrNull(action),
        valueOrNull(payload.companyId),
        valueOrNull(payload.date),
        json(payload),
        json(req.headers),
        req.rawBody || json(payload),
      ]
    );

    res.status(202).json({ status: 'accepted' });
  });

  app.post('/jobs/backfill', async (req, res) => {
    const options = { ...req.body };
    runBackfill(options).catch(err => log('error', 'async backfill failed', { error: err.message }));
    res.status(202).json({ status: 'started', job: 'backfill', options });
  });

  app.post('/jobs/reconcile', async (_req, res) => {
    runReconciliation().catch(err => log('error', 'async reconciliation failed', { error: err.message }));
    res.status(202).json({ status: 'started', job: 'reconciliation' });
  });

  return app;
}

function listen(app) {
  return app.listen(PORT, () => {
    log('info', 'server started', { port: PORT });
  });
}

module.exports = { createApp, listen };
