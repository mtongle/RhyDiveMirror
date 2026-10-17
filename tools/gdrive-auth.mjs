#!/usr/bin/env node
/**
 * One-off helper to mint a Google Drive OAuth refresh token for RhyDiveMirror.
 *
 * It uses loopback redirect (http://127.0.0.1:53682) and the `drive.file` scope
 * (least privilege, non-sensitive, gives the mirror access only to files it created).
 *
 * Usage:
 *   node tools/gdrive-auth.mjs --client-id <ID> --client-secret <SECRET>
 */

import http from 'node:http';
import { exec } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const clientId = args['client-id'] ?? process.env.GDRIVE_CLIENT_ID;
const clientSecret = args['client-secret'] ?? process.env.GDRIVE_CLIENT_SECRET;
const port = 53682;
const redirectUri = `http://127.0.0.1:${port}`;
const scope = 'https://www.googleapis.com/auth/drive.file';

if (!clientId || !clientSecret) {
  console.error('Usage: node tools/gdrive-auth.mjs --client-id <ID> --client-secret <SECRET>');
  console.error('Or set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in environment.');
  process.exit(1);
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

console.log('Opening browser for Google Drive authorization...\nIf it does not open, visit:\n', authUrl, '\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/') {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>授权失败</h1><p>${error}</p>`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('Missing code');
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      throw new Error(tokens.error_description || tokens.error || 'No refresh_token returned');
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>授权成功！</h1><p>您可以关闭此窗口，回到终端查看 Refresh Token。</p>');

    console.log('================ 授权成功 ================');
    console.log(`GDRIVE_REFRESH_TOKEN: ${tokens.refresh_token}`);
    console.log('==========================================');
    console.log('\n请在 Cloudflare Worker 中配置 Secret 或环境变量：');
    console.log(`  npx wrangler secret put GDRIVE_CLIENT_ID`);
    console.log(`  npx wrangler secret put GDRIVE_CLIENT_SECRET`);
    console.log(`  npx wrangler secret put GDRIVE_REFRESH_TOKEN`);
    console.log('\n同时在 wrangler.toml 中开启 hybrid 布局：');
    console.log(`  STORAGE_LAYOUT = "hybrid"`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>交换 Token 失败</h1><p>${err.message}</p>`);
    console.error('Failed to exchange code:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(port, '127.0.0.1', () => {
  const start =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  exec(`${start} "${authUrl}"`);
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}
