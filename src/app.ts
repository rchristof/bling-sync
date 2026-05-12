import type { Application, NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import express from 'express';
import { APP_NAME, BLING_CLIENT_ID, BLING_OAUTH_BASE_URL, JSON_BODY_LIMIT, PORT } from './config';
import { pool } from './db';
import { exchangeAuthorizationCode, loadToken } from './oauth';
import { log } from './logger';
import { startInitialBackfill } from './sync';
import { enqueueWebhook, verifyBlingSignature } from './webhooks';

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const pendingStates = new Set<string>();

export function createApp(): Application {
  const app: Application = express();

  app.use(express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf.toString('utf8');
    },
  }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) || crypto.randomUUID();
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

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', app: APP_NAME, uptime: process.uptime() });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      log('error', 'readiness check failed', { error: (err as Error).message });
      res.status(503).json({ status: 'error', error: (err as Error).message });
    }
  });

  app.get('/auth', (_req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.add(state);
    const url = new URL(`${BLING_OAUTH_BASE_URL}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', BLING_CLIENT_ID);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/status', async (_req: Request, res: Response) => {
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
      log('error', 'auth status check failed', { error: (err as Error).message });
      res.status(500).json({ status: 'error', error: (err as Error).message });
    }
  });

  app.get('/auth/callback', async (req: Request, res: Response) => {
    try {
      if (req.query.error) {
        res.status(400).send(`Bling authorization error: ${req.query.error_description || req.query.error}`);
        return;
      }

      const state = req.query.state as string | undefined;
      if (!state || !pendingStates.has(state)) {
        res.status(400).send('Invalid or missing state parameter');
        return;
      }
      pendingStates.delete(state);

      if (!req.query.code) {
        res.status(400).send('Missing authorization code');
        return;
      }

      await exchangeAuthorizationCode(req.query.code as string);
      startInitialBackfill('oauth_callback');
      res.send('Bling authorization finished. Token saved. Initial backfill started.');
    } catch (err) {
      log('error', 'oauth callback failed', { error: (err as Error).message });
      res.status(500).send((err as Error).message);
    }
  });

  app.post('/webhooks/bling', async (req: Request, res: Response) => {
    const signature = req.headers['x-bling-signature-256'] as string | undefined;

    if (!verifyBlingSignature(req.rawBody, signature)) {
      log('warn', 'webhook signature invalid', {
        hasSignature: Boolean(signature),
        ip: req.ip,
      });
      res.status(401).json({ status: 'unauthorized' });
      return;
    }

    try {
      await enqueueWebhook(req.body, req.headers, req.rawBody!);
    } catch (err) {
      log('error', 'webhook enqueue failed', {
        error: (err as Error).message,
        event: req.body?.event,
        eventId: req.body?.eventId,
      });
      res.status(500).json({ status: 'error' });
      return;
    }

    res.status(202).json({ status: 'accepted' });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
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

export function listen(app: Application) {
  return app.listen(PORT, () => {
    log('info', 'server started', { port: PORT });
  });
}
