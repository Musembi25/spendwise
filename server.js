'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const COOKIE_NAME = 'spendwise_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/api-client.js', ['api-client.js', 'text/javascript; charset=utf-8']],
  ['/manifest.json', ['manifest.json', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/give-money.png', ['give-money.png', 'image/png']]
]);

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const sessionSecret = process.env.SESSION_SECRET || '';
const cookieSecure = process.env.COOKIE_SECURE === 'true';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number.');
}
if (sessionSecret.length < 32) {
  throw new Error('Set SESSION_SECRET in .env to a random value with at least 32 characters.');
}
if (sessionSecret === 'replace-with-a-random-secret-at-least-32-characters') {
  throw new Error('Replace the SESSION_SECRET example value with a randomly generated secret.');
}
if (process.env.NODE_ENV === 'production' && !cookieSecure) {
  throw new Error('Set COOKIE_SECURE=true when running in production over HTTPS.');
}
if ((supabaseUrl && !supabaseKey) || (!supabaseUrl && supabaseKey)) {
  throw new Error('Set both SUPABASE_URL and SUPABASE_ANON_KEY, or leave both blank.');
}
if (supabaseUrl && new URL(supabaseUrl).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(supabaseUrl).hostname)) {
  throw new Error('SUPABASE_URL must use HTTPS, except for localhost development.');
}

const encryptionKey = /^[a-f\d]{64}$/i.test(sessionSecret)
  ? Buffer.from(sessionSecret, 'hex')
  : crypto.createHash('sha256').update(sessionSecret).digest();

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function setSessionCookie(response, session) {
  const payload = Buffer.from(JSON.stringify({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: Date.now() + Number(session.expires_in || 3600) * 1000,
    user: { id: session.user.id, email: session.user.email }
  }));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const cookie = [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
  const flags = [`${COOKIE_NAME}=${cookie}`, 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure) flags.push('Secure');
  response.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(response) {
  const flags = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (cookieSecure) flags.push('Secure');
  response.setHeader('Set-Cookie', flags.join('; '));
}

function readSessionCookie(request) {
  const cookieHeader = request.headers.cookie || '';
  const value = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!value) return null;
  try {
    const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function requireSupabase(response) {
  if (supabaseUrl && supabaseKey) return true;
  json(response, 503, { error: 'Account sync is not configured on this server yet.' });
  return false;
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    if (request.body !== undefined) {
      if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) {
        resolve(request.body);
        return;
      }
      try {
        const raw = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : request.body;
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
      return;
    }
    let body = '';
    let size = 0;
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        request.resume();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    request.on('error', error => {
      if (!settled) reject(error);
    });
  });
}

function checkSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const forwardedProto = request.headers['x-forwarded-proto']?.split(',')[0]?.trim();
  const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
  const host = request.headers['x-forwarded-host']?.split(',')[0]?.trim() || request.headers.host;
  if (!host || origin !== `${protocol}://${host}`) {
    json(response, 403, { error: 'Cross-origin requests are not allowed.' });
    return false;
  }
  return true;
}

async function supabaseRequest(endpoint, { method = 'GET', token, body, prefer } = {}) {
  const isAuth = endpoint.startsWith('/auth/v1/');
  const response = await fetch(`${supabaseUrl}${endpoint}`, {
    method,
    headers: {
      apikey: supabaseKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(!isAuth || body ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let result = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }
  if (!response.ok) {
    const error = new Error(result?.msg || result?.message || result?.error_description || result?.error || 'The account service could not complete the request.');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function getAuthenticatedSession(request, response) {
  const session = readSessionCookie(request);
  if (!session?.accessToken || !session?.refreshToken) {
    clearSessionCookie(response);
    json(response, 401, { error: 'Sign in to sync your data.' });
    return null;
  }
  if (session.expiresAt > Date.now() + 60000) return session;
  try {
    const refreshed = await supabaseRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: session.refreshToken }
    });
    setSessionCookie(response, refreshed);
    return {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      user: { id: refreshed.user.id, email: refreshed.user.email }
    };
  } catch (error) {
    clearSessionCookie(response);
    json(response, 401, { error: 'Your session expired. Please sign in again.' });
    return null;
  }
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json(response, 200, { ok: true, accountsConfigured: Boolean(supabaseUrl && supabaseKey) });
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    if (!supabaseUrl || !supabaseKey) {
      clearSessionCookie(response);
      return json(response, 200, { user: null, accountsConfigured: false });
    }
    if (!readSessionCookie(request)) {
      clearSessionCookie(response);
      return json(response, 200, { user: null, accountsConfigured: true });
    }
    const session = await getAuthenticatedSession(request, response);
    if (!session) return;
    return json(response, 200, { user: session.user, accountsConfigured: true });
  }

  if (!checkSameOrigin(request, response)) return;
  if (!requireSupabase(response)) return;

  if (url.pathname === '/api/auth/signup' && request.method === 'POST') {
    const body = await parseBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 256) {
      return json(response, 400, { error: 'Enter a valid email and a password between 8 and 256 characters.' });
    }
    const result = await supabaseRequest('/auth/v1/signup', { method: 'POST', body: { email, password } });
    if (result?.access_token && result?.user) {
      setSessionCookie(response, result);
      return json(response, 201, { user: { id: result.user.id, email: result.user.email } });
    }
    return json(response, 201, { confirmationRequired: true });
  }

  if (url.pathname === '/api/auth/signin' && request.method === 'POST') {
    const body = await parseBody(request);
    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 256) {
      return json(response, 400, { error: 'Enter a valid email and password.' });
    }
    const result = await supabaseRequest('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    setSessionCookie(response, result);
    return json(response, 200, { user: { id: result.user.id, email: result.user.email } });
  }

  if (url.pathname === '/api/auth/signout' && request.method === 'POST') {
    const session = readSessionCookie(request);
    clearSessionCookie(response);
    if (session?.accessToken) {
      try {
        await supabaseRequest('/auth/v1/logout', { method: 'POST', token: session.accessToken });
      } catch (error) {
        if (error.status !== 401) throw error;
      }
    }
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/api/data' && (request.method === 'GET' || request.method === 'PUT')) {
    const session = await getAuthenticatedSession(request, response);
    if (!session) return;
    const userFilter = `user_id=eq.${encodeURIComponent(session.user.id)}`;
    if (request.method === 'GET') {
      const rows = await supabaseRequest(`/rest/v1/spendwise_data?select=data&${userFilter}&limit=1`, { token: session.accessToken });
      return json(response, 200, { data: rows?.[0]?.data || null });
    }
    const body = await parseBody(request);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return json(response, 400, { error: 'Data must be a JSON object.' });
    }
    await supabaseRequest('/rest/v1/spendwise_data?on_conflict=user_id', {
      method: 'POST',
      token: session.accessToken,
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { user_id: session.user.id, data: body.data, updated_at: new Date().toISOString() }
    });
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: 'API route not found.' });
}

function serveStatic(request, response, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) return json(response, 404, { error: 'Page not found.' });
  const [name, contentType] = file;
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': ['index.html', 'api-client.js', 'sw.js'].includes(name) ? 'no-cache' : 'public, max-age=3600'
  };
  if (name === 'index.html') {
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  }
  response.writeHead(200, headers);
  fs.createReadStream(path.join(ROOT, name)).pipe(response);
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      serveStatic(request, response, url.pathname);
    } else {
      json(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 502;
    if (status >= 500) console.error(`SpendWise API error: ${error.message}`);
    json(response, status, { error: status >= 500 ? 'The account service is temporarily unavailable. Please try again.' : error.message });
  }
}

module.exports = { handleRequest };

if (require.main === module) {
  http.createServer(handleRequest).listen(port, '0.0.0.0', () => {
    console.log(`SpendWise is listening on port ${port}.`);
    if (!supabaseUrl || !supabaseKey) console.warn('Account sync is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to .env.');
  });
}
