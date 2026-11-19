// Browser sign-in without a Basic challenge or any executable page assets.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildSessionCookie, issueSessionToken, matchCredentials } from './auth.js';

const MAX_FORM_BYTES = 4096;
const FORM_TYPE = 'application/x-www-form-urlencoded';
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Same-origin form posts need an Origin header; no-referrer makes it null.
  'Referrer-Policy': 'same-origin',
};

export function sendLoginPage(res: ServerResponse, status = 401, invalid = false): void {
  res.writeHead(status, HTML_HEADERS);
  res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#282a36">
<title>Sign in to Tau</title>
<style>
  :root { color-scheme: dark; font: 100%/1.5 system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { background: #282a36; color: #f8f8f2; margin: 0; }
  main { margin: clamp(2rem, 12vh, 8rem) auto; width: min(26rem, calc(100% - 2rem));
    padding: 1.5rem; border: 1px solid #44475a; border-radius: .75rem; background: #353747; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  form { display: grid; gap: 1rem; }
  label { display: grid; gap: .25rem; font-weight: 600; }
  input, button { font: inherit; border-radius: .4rem; min-height: 2.75rem; }
  input { width: 100%; background: #282a36; color: inherit; border: 1px solid #8a96bc; padding: .5rem; }
  ::selection { background: #44475a; color: #f8f8f2; }
  button { background: #bd93f9; color: #282a36; border: 0; padding: .5rem .75rem; cursor: pointer; }
  :focus-visible { outline: 2px solid #8be9fd; outline-offset: 2px; }
  [role=alert] { color: #ff8080; margin: 0 0 1rem; }
</style>
<main>
  <h1>Sign in to Tau</h1>
  ${invalid ? '<p role="alert">Invalid username or password.</p>' : ''}
  <form action="/login" method="post">
    <label>Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</main>
</html>`);
}

export async function submitLogin(req: IncomingMessage, res: ServerResponse, secure: boolean): Promise<void> {
  // Cross-site forms must not sign the browser into a session, even if an old
  // cookie or saved Basic credentials are sent with the request.
  const host = req.headers.host;
  if (!host || req.headers.origin !== `${secure ? 'https' : 'http'}://${host}`) {
    return sendLoginPage(res, 403, true);
  }
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== FORM_TYPE) {
    return sendLoginPage(res, 415, true);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  // The HTTP client controls the stream, not just Content-Length. On overflow
  // stop buffering and close the connection after sending the response.
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > MAX_FORM_BYTES) {
        res.setHeader('Connection', 'close');
        return sendLoginPage(res, 413, true);
      }
      chunks.push(chunk);
    }
  } catch {
    if (!res.destroyed) sendLoginPage(res, 400, true);
    return;
  }
  const fields = new URLSearchParams(Buffer.concat(chunks, bytes).toString('utf8'));
  const users = fields.getAll('username');
  const passwords = fields.getAll('password');
  if (users.length !== 1 || passwords.length !== 1 || !matchCredentials(users[0], passwords[0])) {
    return sendLoginPage(res, 401, true);
  }
  res.writeHead(303, {
    'Cache-Control': 'no-store',
    'Location': '/',
    'Set-Cookie': buildSessionCookie(issueSessionToken(), { secure }),
  });
  res.end();
}
