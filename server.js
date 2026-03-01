#!/usr/bin/env node
/*
  Minimal Express server that exposes a /book endpoint so you can trigger
  booking.js from your phone (iOS Shortcut, browser, etc.) without needing
  a terminal.

  POST /book
  Body (JSON): { "date": "wednesday march 4 6-8pm", "capacity": 6 }

  The server spawns booking.js in headless + fully-automatic mode and
  streams the log output back as plain text in the response.

  Protect the endpoint with a secret token set via the API_TOKEN env var.
  The iOS Shortcut (or any client) must send:
    Authorization: Bearer <your token>

  Env vars (set these in Railway):
    PORT          — Railway sets this automatically
    API_TOKEN     — secret string you choose; used to protect /book
    USER_EMAIL    — Active Mississauga login
    USER_PASSWORD — Active Mississauga password
*/

const http    = require('http');
const { spawn } = require('child_process');
const path    = require('path');
const url     = require('url');

const PORT      = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';

// --- simple request body reader ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// --- auth check ---
function isAuthorized(req) {
  if (!API_TOKEN) return true; // no token configured → open (not recommended for prod)
  const authHeader = req.headers['authorization'] || '';
  return authHeader === `Bearer ${API_TOKEN}`;
}

// --- spawn booking.js and stream output ---
function runBooking(date, capacity, onData, onDone) {
  const args = [
    path.join(__dirname, 'booking.js'),
    '--headless',
    '--yes',
    '--auto',
    '--quiet',
    '--date', date,
    '--capacity', String(Number(capacity) || 4),
  ];

  const child = spawn(process.execPath, args, {
    env: { ...process.env },
    cwd: __dirname,
  });

  // sanitize output from child process (strip ANSI/control chars) so logs
  // are safe to JSON-encode and view in tools like `jq`.
  const sanitize = (s) => {
    if (!s) return '';
    let out = String(s);
    // Remove ANSI escape sequences (colors, cursor movement, etc.)
    out = out.replace(/\x1b\[[0-9;]*m/g, '');
    // Remove other C0 control characters except newline and tab
    out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    // Normalize CRLF to LF
    out = out.replace(/\r\n?/g, '\n');
    return out;
  };

  child.stdout.on('data', d => onData(sanitize(d.toString())));
  child.stderr.on('data', d => onData(sanitize('[stderr] ' + d.toString())));
  child.on('close', code => onDone(code));
  child.on('error', err => {
    try {
      onData('[error] spawn failed: ' + (err && err.message ? err.message : String(err)) + '\n');
    } catch {}
    try { onDone(127); } catch {}
  });
}

// --- background job store (in-memory) ---
const jobs = new Map();
let jobCounter = 0;


// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url || '');

  // Health-check — Railway / uptime monitors hit GET /
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Room Booker is running. POST /book to trigger a booking.');
    return;
  }

  // Booking endpoint
  if (req.method === 'POST' && pathname === '/book') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Provide Authorization: Bearer <API_TOKEN>.' }));
      return;
    }

    let body = {};
    try {
      body = await readBody(req);
    } catch (e) {
      console.error('Error parsing request body:', e && e.stack ? e.stack : e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body', detail: String(e && e.message ? e.message : e) }));
      return;
    }
    const date     = (body.date || '').trim();
    const capacity = Number(body.capacity) || 4;

    if (!date) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "date" field. Example: "wednesday march 4 6-8pm"' }));
      return;
    }

    // Enqueue job and return job id immediately. Booking runs in background.
    const jobId = `${Date.now().toString(36)}-${++jobCounter}`;
    const job = {
      id: jobId,
      status: 'queued',
      createdAt: Date.now(),
      date,
      capacity,
      log: '',
      exitCode: null,
      summary: null,
      finishedAt: null,
    };
    jobs.set(jobId, job);

    // Start processing in background
    (async () => {
      try {
        job.status = 'running';
        // immediate marker so clients see the job started even if child hasn't emitted output yet
        job.log += 'STEP: job-started\n';
        job.lastUpdated = Date.now();
        runBooking(date, capacity,
          (line) => { job.log += line; job.lastUpdated = Date.now(); },
          (code) => {
            job.exitCode = code;
            job.finishedAt = Date.now();
            const log = job.log || '';
            const summaryMatch = log.match(/✔\s*(.+)/);
            const errorMatch = log.match(/^ERROR:\s*(.+)$/m);
            if (errorMatch) {
              job.summary = errorMatch[1].trim();
              job.status = 'failed';
            } else if (summaryMatch) {
              job.summary = summaryMatch[1].trim();
              job.status = 'done';
            } else {
              job.summary = null;
              job.status = (code === 0) ? 'done' : 'failed';
            }
          }
        );
      } catch (e) {
        job.status = 'failed';
        job.log += `\n[server error] ${e.message}`;
        job.finishedAt = Date.now();
      }
    })();

    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jobId, statusUrl: `/status/${jobId}` }));
    return;
  }

  // 404 for everything else
  // Status endpoint for polling job results: GET /status/<jobId>
  if (req.method === 'GET' && pathname && pathname.startsWith('/status/')) {
    const id = pathname.replace('/status/', '').trim();
    const job = jobs.get(id);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }
    // Return job info (truncate log to reasonable length)
    const maxLog = 50_000;
    const log = job.log && job.log.length > maxLog ? job.log.slice(-maxLog) : job.log;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      summary: job.summary,
      log,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. Available: GET / | POST /book | GET /status/<jobId>');
});

server.listen(PORT, () => {
  console.log(`Room Booker server listening on port ${PORT}`);
  if (!API_TOKEN) {
    console.warn('WARNING: API_TOKEN is not set. The /book endpoint is unprotected!');
  }
});

// Global error handlers — surface to console so Railway logs capture them
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});
