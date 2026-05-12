import axios from 'axios';
import fs from 'fs';
import { BLING_CLIENT_ID, BLING_CLIENT_SECRET, BLING_OAUTH_BASE_URL, TOKEN_EXPIRY_SKEW_MS, TOKEN_FILE } from './config';
import { pool } from './db';
import { log } from './logger';

export interface OAuthToken {
  id?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  expires_at?: string;
  saved_at?: string;
  raw?: string;
  updated_at?: Date;
}

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64')}`;
}

export async function seedTokenFromFileIfNeeded(): Promise<void> {
  const { rows } = await pool.query('SELECT id FROM bling_oauth_tokens WHERE id = $1', ['default']);
  if (rows.length > 0 || !fs.existsSync(TOKEN_FILE)) return;

  let token: OAuthToken;
  try {
    token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (err) {
    log('error', 'failed to read .token.json seed file', { error: (err as Error).message, path: TOKEN_FILE });
    return;
  }

  await saveToken(token);
  log('info', 'oauth token imported from .token.json');
}

export async function loadToken(): Promise<OAuthToken | null> {
  const { rows } = await pool.query('SELECT * FROM bling_oauth_tokens WHERE id = $1', ['default']);
  return rows[0] || null;
}

function parseDateOrNull(value: unknown): Date | null {
  if (!value) return null;

  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveTokenExpiresAt(token: OAuthToken, previousToken: OAuthToken = {}): Date | null {
  const explicitExpiresAt = parseDateOrNull(token.expires_at);
  if (explicitExpiresAt) return explicitExpiresAt;

  const expiresIn = Number(token.expires_in || previousToken.expires_in || 0);
  if (!expiresIn) return null;

  const savedAt = parseDateOrNull(token.saved_at);
  const baseTime = savedAt ? savedAt.getTime() : Date.now();
  return new Date(baseTime + expiresIn * 1000);
}

export async function saveToken(token: OAuthToken, previousToken: OAuthToken = {}): Promise<void> {
  const expiresIn = Number(token.expires_in || previousToken.expires_in || 0);
  const expiresAt = resolveTokenExpiresAt(token, previousToken);

  await pool.query(
    `INSERT INTO bling_oauth_tokens (
       id, access_token, refresh_token, token_type, scope, expires_in, expires_at, raw, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, bling_oauth_tokens.refresh_token),
       token_type    = EXCLUDED.token_type,
       scope         = EXCLUDED.scope,
       expires_in    = EXCLUDED.expires_in,
       expires_at    = EXCLUDED.expires_at,
       raw           = EXCLUDED.raw,
       updated_at    = NOW()`,
    [
      'default',
      token.access_token || previousToken.access_token,
      token.refresh_token || previousToken.refresh_token,
      token.token_type || previousToken.token_type || 'Bearer',
      token.scope || previousToken.scope || null,
      expiresIn || previousToken.expires_in || null,
      expiresAt,
      JSON.stringify(token || {}),
    ]
  );
}

function tokenIsExpiring(token: OAuthToken): boolean {
  if (!token?.expires_at) return false;
  return Date.now() >= new Date(token.expires_at).getTime() - TOKEN_EXPIRY_SKEW_MS;
}

async function requestToken(params: Record<string, string>, previousToken: OAuthToken = {}): Promise<OAuthToken> {
  let data: OAuthToken;

  try {
    ({ data } = await axios.post(
      `${BLING_OAUTH_BASE_URL}/token`,
      new URLSearchParams(params),
      {
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'enable-jwt': '1',
        },
        timeout: 15000,
      }
    ));
  } catch (err: any) {
    const status = err.response?.status;
    const details = err.response?.data || err.message;
    throw new Error(`Bling OAuth error ${status || err.code || ''}: ${JSON.stringify(details)}`);
  }

  await saveToken(data, previousToken);
  return data;
}

export async function exchangeAuthorizationCode(code: string): Promise<OAuthToken> {
  return requestToken({ grant_type: 'authorization_code', code });
}

export async function refreshAccessToken(token: OAuthToken | null = null): Promise<OAuthToken> {
  const currentToken = token || await loadToken();
  if (!currentToken?.refresh_token) {
    throw new Error('Missing refresh_token. Open /auth first.');
  }

  log('info', 'refreshing bling access token');
  return requestToken(
    { grant_type: 'refresh_token', refresh_token: currentToken.refresh_token },
    currentToken
  );
}

export async function getValidAccessToken(): Promise<string> {
  let token = await loadToken();
  if (!token) throw new Error('No OAuth token found. Open /auth first.');

  if (!token.access_token || tokenIsExpiring(token)) {
    await refreshAccessToken(token);
    token = await loadToken();
  }

  return token!.access_token!;
}
