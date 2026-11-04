/*
 * DS011-COMMS-19: paste into the DevTools Console on the authenticated DevonStation
 * application (NOT the Cloudflare Access sign-in page or a file preview).
 * Read-only. No passwords, message text, tokens, or headers are printed.
 */
(async () => {
  'use strict';
  const ORIGIN = 'https://ds.devonakins.com';
  const CANARY = '1ba61404-f7f6-4b0b-8b55-6f9f52819e70';
  const report = (stage, result, detail) => console.info('DS-MAIL-ACCEPTANCE', {stage, result, detail});

  if (location.origin !== ORIGIN) {
    report('preflight', 'WRONG_ORIGIN', 'Open the authenticated DevonStation tab at ds.devonakins.com.');
    return;
  }
  if (window.top !== window.self) {
    report('preflight', 'WRONG_FRAME', 'Select the top-level DevonStation page in the Console context menu.');
    return;
  }
  if (document.title !== 'Devon Station' || !document.querySelector('.app main#view')) {
    report('preflight', 'NOT_APP', 'Cloudflare Access sign-in or another page is displayed. Finish sign-in until the DevonStation workspace appears, then rerun.');
    return;
  }
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  const csp = meta?.getAttribute('content') || '';
  const connect = csp.split(';').map(x => x.trim()).find(x => x.startsWith('connect-src '));
  if (!connect || !connect.split(/\s+/).includes("'self'")) {
    report('preflight', 'BLOCKED_BY_PAGE_CSP', 'The running page lacks same-origin connect-src permission; check the served HTML and response CSP before changing policy.');
    return;
  }
  report('preflight', 'APP_CONFIRMED', 'Authenticated application document with same-origin HTML CSP; testing GET endpoints only.');

  async function request(path, headers = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
        headers: {Accept: 'application/json', ...headers}
      });
    } catch (error) {
      return {kind: 'NETWORK_OR_CSP_BLOCK', httpStatus: null, name: error?.name === 'TypeError' ? 'TypeError' : 'other'};
    }
    if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) {
      return {kind: 'LOGIN_REDIRECT', httpStatus: response.status};
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return {kind: 'NOT_JSON', httpStatus: response.status};
    }
    let body;
    try { body = await response.json(); } catch {return {kind: 'INVALID_JSON', httpStatus: response.status};}
    return {kind: response.ok ? 'OK' : 'HTTP_ERROR', httpStatus: response.status, body};
  }

  const session = await request('/api/session');
  if (session.kind !== 'OK' || session.body?.authenticated !== true) {
    report('session', session.kind, {httpStatus: session.httpStatus, reason: 'Owner authentication not verified. No mail request attempted.'});
    return;
  }
  report('session', 'OWNER_SESSION_VERIFIED', {httpStatus: session.httpStatus});
  const status = await request('/api/mail/status', {
    'Cloudflare-Workers-Version-Overrides': 'devon-station="' + CANARY + '"'
  });
  if (status.kind !== 'OK') {
    report('canary', status.kind, {httpStatus: status.httpStatus, reason: 'Read-only candidate not reached; no email operation attempted.'});
    return;
  }
  const d = status.body || {};
  report('canary', 'STATUS_RECEIVED', {
    httpStatus: status.httpStatus,
    configured: d.configured === true,
    provider: d.provider === 'purelymail' ? 'purelymail' : 'unknown',
    draftsEnabled: d.draftsEnabled === true,
    sendingDisabled: d.outgoingEnabled === false,
    outboxDisabled: d.outboxEnabled === false
  });
})();
