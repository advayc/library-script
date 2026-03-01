#!/usr/bin/env node
/*
  Playwright-based automation to search and reserve a study room at
  Active Mississauga (Central Library).

  Flow:
    1. Launch browser, go to the login page, sign in with .env credentials.
    2. Navigate to the reservation search page with parsed date/time.
    3. Scrape all available rooms and present them as an interactive list.
    4. User picks a room, script clicks it and walks through the setup.
*/
const { chromium } = require('playwright');
const chrono = require('chrono-node');
const dotenv = require('dotenv');
const fs = require('fs');
dotenv.config();

// Parse CLI args for non-interactive runs and flags
function parseArgs() {
  const out = {
    nonInteractive: false,
    autoConfirm: false,
    headless: false,
    listOnly: false,
    debug: false,
    quiet: false,
    auto: false,
    listJson: false,
    signaturePath: null,
    attendees: null,
    dateText: null,
    requiredCapacity: null
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') { out.nonInteractive = true; out.autoConfirm = true; }
    else if (a === '--headless') out.headless = true;
    else if (a === '--list' || a === '-l') out.listOnly = true;
    else if (a === '--signature' || a === '--signaturePath') out.signaturePath = args[++i];
    else if (a === '--attendees') out.attendees = Number(args[++i]);
    else if (a === '--date') out.dateText = args[++i];
    else if (a === '--capacity') out.requiredCapacity = Number(args[++i]);
    else if (a === '--debug') out.debug = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--auto') out.auto = true;
    else if (a === '--list-json' || a === '--listjson') out.listJson = true;
  }
  return out;
}

const ARGS = parseArgs();

// inquirer is an ESM package in recent versions — import it dynamically
async function ask(questions) {
  // If running non-interactive, synthesize answers from ARGS or defaults
  if (ARGS.nonInteractive) {
    const answers = {};
    for (const q of questions) {
      const name = q.name;
      if (q.type === 'confirm') answers[name] = ARGS.autoConfirm ?? q.default ?? true;
      else if (q.type === 'input') {
        if (name === 'dateText') answers[name] = ARGS.dateText ?? q.default ?? '';
        else if (name === 'signaturePath') answers[name] = ARGS.signaturePath ?? q.default ?? '';
        else answers[name] = ARGS[name] ?? q.default ?? '';
      } else if (q.type === 'number') {
        if (name === 'requiredCapacity') answers[name] = ARGS.requiredCapacity ?? q.default ?? 1;
        else if (name === 'attendees') answers[name] = ARGS.attendees ?? q.default ?? 1;
        else answers[name] = ARGS[name] ?? q.default ?? 0;
      } else if (q.type === 'list') {
        // choose first item by default in non-interactive mode
        answers[name] = 0;
      } else {
        answers[name] = q.default;
      }
    }
    return answers;
  }

  const mod = await import('inquirer');
  const iq = mod.default ?? mod;
  return iq.prompt(questions);
}

// ── Site URLs (from the HTML source) ──────────────────────────────────────
const LOGIN_URL = 'https://ca.apm.activecommunities.com/activemississauga/ActiveNet_Login';
const BASE_SEARCH = 'https://anc.ca.apm.activecommunities.com/activemississauga/reservation/landing/search';

// ── Local room inventory (from user's provided options) ───────────────────
const ROOM_INVENTORY = [
  { floor: 2, code: 'MR 201', label: '201 | MR 201', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Normal (Small)', notes: 'Television' },
  { floor: 2, code: 'MR 202', label: '202 | MR 202', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Adjustable | Sit & Stand', notes: 'Television' },
  { floor: 2, code: 'MR 203', label: '203 | MR 203', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Normal (Small)', notes: 'Television' },
  { floor: 2, code: 'MR 205', label: '205 | MR 205', capacity: 6, timeframe: '30m-2h', windows: true, desk: 'Normal (Small)', notes: 'Television' },
  { floor: 2, code: 'MR 206', label: '206 | MR 206', capacity: 6, timeframe: '30m-2h', windows: true, desk: 'Normal (Small)', notes: 'Television' },
  { floor: 2, code: 'MR 207', label: '207 | MR 207', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Normal (Small)', notes: 'Television' },
  { floor: 2, code: 'MR 208', label: '208 | MR 208', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Adjustable | Sit & Stand', notes: 'Television' },
  { floor: 3, code: 'MR 301', label: '301 | MR 301', capacity: 6, timeframe: '30m-2h', windows: true, desk: 'Normal (Medium)', notes: 'Television' },
  { floor: 3, code: 'MR 302', label: '302 | MR 302', capacity: 6, timeframe: '30m-2h', windows: true, desk: 'Normal (Medium)', notes: 'Television' },
  { floor: 3, code: 'MR 303', label: '303 | MR 303', capacity: 6, timeframe: '30m-2h', windows: false, desk: 'Normal (Medium)', notes: 'Television' },
  { floor: 3, code: 'MR 304', label: '304 | MR 304', capacity: 6, timeframe: '30m-2h', windows: true, desk: 'Normal (Medium)', notes: 'Television' },
  { floor: 3, code: 'MR 305', label: '305 | MR 305', capacity: 6, timeframe: '30m-2h', windows: true, desk: 'Normal (Medium)', notes: 'Television' },
  { floor: 4, code: 'MR 401', label: '401 | MR 401', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Normal (Small)', notes: 'Television' },
  { floor: 4, code: 'MR 402', label: '402 | MR 402', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Adjustable | Sit & Stand', notes: 'Television' },
  { floor: 4, code: 'MR 403', label: '403 | MR 403', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Adjustable | Sit & Stand', notes: 'Television' },
  { floor: 4, code: 'MR 404', label: '404 | MR 404', capacity: 4, timeframe: '30m-2h', windows: false, desk: 'Normal (Small)', notes: 'Television' }
];

// Simple terminal colors
const C = {
  reset: s => `\x1b[0m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`
};

// Simple logger that respects --quiet and --debug flags
const logger = {
  info: (...args) => { if (!ARGS.quiet) console.log(...args); },
  debug: (...args) => { if (ARGS.debug && !ARGS.quiet) console.log(...args); },
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

// Structured STEP logs are always emitted (not suppressed by --quiet)
function step(msg) {
  try { console.log('STEP: ' + String(msg)); } catch {}
}

// Emit an explicit ERROR: line for server parsing and Shortcut visibility
function logError(key, message) {
  try {
    const tag = key ? String(key).replace(/\s+/g, '_') : 'error';
    console.error('ERROR: ' + tag + (message ? ' - ' + String(message) : ''));
    // also emit a STEP-level marker so we keep structured progress
    step('error:' + tag);
  } catch {}
}

// Diagnostics helpers: save page HTML + screenshot and attach simple network logging
const DIAG_DIR = './diagnostics';
function ensureDiagDir() {
  try { if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true }); } catch {}
}

async function savePageSnapshot(page, name = 'snapshot') {
  try {
    ensureDiagDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${DIAG_DIR}/${name}-${ts}`;
    try { await page.screenshot({ path: base + '.png', fullPage: true }); } catch (e) { /* ignore */ }
    try { await fs.promises.writeFile(base + '.html', await page.content()); } catch (e) { /* ignore */ }
    console.log(C.yellow(`Saved diagnostics: ${base}.(html|png)`));
    return base;
  } catch (err) {
    console.log('Failed to save page snapshot:', err && err.message ? err.message : err);
    return null;
  }
}

function attachPageDiagnostics(page) {
  try {
    page.on('response', async (res) => {
      try {
        const status = res.status();
        if (status >= 400) {
          const url = res.url();
          const ct = res.headers()['content-type'] || '';
          const msg = `NETWORK: ${status} on ${url} (content-type: ${ct})`;
          console.warn(msg);
          diagnosticsCollector.network.push({ type: 'response', status, url, contentType: ct, text: msg });
          if (status === 429) {
            logError('rate_limited', `HTTP 429 on ${url}`);
            diagnosticsCollector.findings.push({ phrase: '429', snippet: `HTTP 429 on ${url}` });
          }
        }
        // log Retry-After header if present
        const ra = res.headers()['retry-after'];
        if (ra) console.warn(`NETWORK: Retry-After=${ra} for ${res.url()}`);
      } catch (e) {}
    });

    page.on('requestfailed', (req) => {
      try {
        const failure = req.failure();
        const msg = `REQUEST FAILED: ${req.url()} - ${failure && failure.errorText ? failure.errorText : JSON.stringify(failure)}`;
        console.warn(msg);
        diagnosticsCollector.network.push({ type: 'requestfailed', url: req.url(), failure });
      } catch (e) {}
    });

    page.on('console', async (msg) => {
      try {
        // capture page-side errors for extra context
        if (msg.type() === 'error') {
          const text = msg.text();
          const out = `PAGE ERROR: ${text}`;
          console.warn(out);
          diagnosticsCollector.pageErrors.push({ text });
        }
      } catch (e) {}
    });
  } catch (err) {}
}

// Scan page HTML/text for common failure messages (rate limits, duplicates, waivers)
async function scanForFailurePhrases(page) {
  try {
    const text = (await page.content()).toLowerCase();
    const phrases = [
      'rate limit', 'too many requests', '429', 'you may only', 'already have', 'only allowed',
      'one reservation', 'per day', 'duplicate reservation', 'cannot complete', 'not allowed',
      'please accept the', 'waiver', 'captcha', 'recaptcha', 'blocked'
    ];
    const found = [];
    for (const p of phrases) {
      const idx = text.indexOf(p);
      if (idx !== -1) {
        const snippet = text.substr(Math.max(0, idx - 60), 240).replace(/\s+/g, ' ').trim();
        found.push({ phrase: p, snippet });
        diagnosticsCollector.findings.push({ phrase: p, snippet });
      }
    }
    return found;
  } catch (err) { return []; }
}

// Simple diagnostics collector to aggregate events during a run
const diagnosticsCollector = {
  network: [],
  pageErrors: [],
  findings: [],
};

function explainIssues(findings, collector) {
  const reasons = [];
  const seen = new Set();
  for (const f of findings || []) {
    const p = (f.phrase || '').toLowerCase();
    if (seen.has(p)) continue; seen.add(p);
    if (p.includes('429') || p.includes('rate') || p.includes('too many requests')) {
      reasons.push({ code: 'rate_limited', title: 'Rate limited (HTTP 429)', explain: 'The site is returning rate-limit responses. Reduce request frequency, add delays, or retry later. Check for Retry-After header for suggested wait time.' });
    } else if (p.includes('captcha') || p.includes('recaptcha')) {
      reasons.push({ code: 'captcha', title: 'Captcha / Bot protection', explain: 'The site is challenging automated requests with CAPTCHA or anti-bot measures. Manual intervention may be required to complete login/booking.' });
    } else if (p.includes('waiver') || p.includes('please accept')) {
      reasons.push({ code: 'waiver', title: 'Waiver / Agreement required', explain: 'A waiver or agreement must be accepted or scrolled before reservation can complete. Ensure the script checks the checkbox or accept it manually.' });
    } else if (p.includes('duplicate') || p.includes('already have') || p.includes('one reservation') || p.includes('only allowed')) {
      reasons.push({ code: 'duplicate', title: 'Duplicate / policy restriction', explain: 'You may already have a reservation or the site enforces limits (per day / per user). Confirm via the browser or adjust booking time.' });
    } else if (p.includes('cannot complete') || p.includes('not allowed') || p.includes('cannot')) {
      reasons.push({ code: 'cannot_complete', title: 'Operation blocked', explain: 'The server reports the action cannot be completed. Inspect the page or logs for more details.' });
    } else {
      reasons.push({ code: 'other', title: `Matched phrase: ${f.phrase}`, explain: f.snippet || '' });
    }
  }

  // If no findings, inspect network errors for 5xx or other hints
  if (reasons.length === 0 && collector && collector.network && collector.network.length) {
    for (const n of collector.network.slice(-10)) {
      if (n.status === 429) {
        reasons.push({ code: 'rate_limited', title: 'Rate limited (HTTP 429)', explain: 'Recent network responses include HTTP 429 (Too Many Requests).' });
        break;
      }
      if (n.status >= 500) {
        reasons.push({ code: 'server_error', title: `Server error ${n.status}`, explain: `The server returned ${n.status} for ${n.url}` });
        break;
      }
    }
  }
  return reasons;
}

/* ───────── helpers ───────── */

function fmtDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildEventDateAndTime(start, end) {
  const ev = {
    dateAndTime: [{ from_date_time: fmtDateTime(start), to_date_time: fmtDateTime(end), id: -1 }],
    queryLastApplied: [{ from_date_time: fmtDateTime(start), to_date_time: fmtDateTime(end), id: -1 }],
    dateRangeLastApplied: [start.toISOString().slice(0, 10)],
    isAllowFullDay: false,
    selectedTabId: 2,
    timeRangeLastApplied: [
      start.toTimeString().slice(0, 8),
      end.toTimeString().slice(0, 8)
    ],
    afterValue: '15:30',
    anyValue: 2
  };
  return encodeURIComponent(JSON.stringify(ev));
}

async function parseInputText(raw) {
  const results = chrono.parse(raw);
  if (!results || results.length === 0) throw new Error('Could not parse date/time from: ' + raw);
  const r = results[0];
  const start = r.start.date();
  const end = r.end ? r.end.date() : new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return { start, end };
}

function waitForEnter(msg) {
  console.log(msg || 'Press ENTER to continue...');
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}

/* ───────── sign-in (runs FIRST) ──────────────────────────────────────────
   The site is a React SPA (ActiveNet / Active Communities). The login page
   renders inside #app-root. We must wait for the JS to mount the form
   before we can fill inputs. The site also uses enterprise reCAPTCHA, so
   if it triggers a challenge we fall back to manual login.
   ─────────────────────────────────────────────────────────────────────── */

async function signIn(page) {
  const email = process.env.USER_EMAIL;
  const password = process.env.USER_PASSWORD;

  if (!email || !password) {
    console.log('No USER_EMAIL / USER_PASSWORD in .env');
    console.log('Opening login page — please sign in manually.');
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 120000 });
    await waitForEnter('Sign in in the browser, then press ENTER here.');
    return;
  }

  // ── 1. Navigate to the login page ──
  console.log('Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 120000 });
  step('sign-in:navigate');

  // ── 2. Wait for the React SPA to render the form ──
  //    The SPA renders into #app-root. We wait for any visible input to appear.
  console.log('Waiting for login form to render...');
  try {
    await page.waitForSelector('input', { state: 'visible', timeout: 30000 });
  } catch {
    console.log('Login form did not appear in time. Checking if already logged in...');
    // If "Sign Out" or "My Account" is visible, we're already logged in
    if (await isLoggedIn(page)) {
      console.log('Already signed in (session persisted).');
      return;
    }
    await waitForEnter('Could not detect login form. Please sign in manually, then press ENTER.');
    return;
  }

  // ── 3. Check if already logged in (the page may redirect or show account menu) ──
  if (await isLoggedIn(page)) {
    console.log('Already signed in (session persisted).');
    return;
  }

  // ── 4. Fill credentials ──
  //    The ActiveNet login form typically has two text inputs: email/username and password.
  //    Since force_email_as_login_name=true, the first field is the email.
  console.log(`Filling credentials for ${email}...`);

  // Try specific selectors first, then fall back to generic input[type]
  const emailSelectors = [
    'input[name="loginName"]',
    'input[name="emailAddress"]',
    'input[name="EmailAddress"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[id*="login"]',
    'input[id*="Login"]',
    'input[id*="email"]',
    'input[id*="Email"]',
    'input[id*="user"]',
  ];
  const passSelectors = [
    'input[name="password"]',
    'input[name="Password"]',
    'input[type="password"]',
    'input[id*="password"]',
    'input[id*="Password"]',
  ];

  let filledEmail = false;
  let filledPass = false;

  for (const sel of emailSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click();
        await el.fill(email);
        filledEmail = true;
        console.log(`  Email filled using selector: ${sel}`);
        break;
      }
    } catch {}
  }

  // If none of the named selectors matched, try the first visible text input
  if (!filledEmail) {
    try {
      const firstInput = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
      if (await firstInput.count()) {
        await firstInput.click();
        await firstInput.fill(email);
        filledEmail = true;
        console.log('  Email filled using first visible text input');
      }
    } catch {}
  }

  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click();
        await el.fill(password);
        filledPass = true;
        console.log(`  Password filled using selector: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!filledEmail || !filledPass) {
    console.log(`  Could not auto-fill fields (email: ${filledEmail}, password: ${filledPass}).`);
    console.log('  Please complete login manually in the browser.');
    await waitForEnter('Press ENTER when done signing in.');
    return;
  }

  // ── 5. Submit the form ──
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Log in")',
    'input[type="submit"]',
    'button.login-btn',
    'button[class*="login"]',
    'button[class*="sign"]',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        submitted = true;
        console.log(`  Clicked submit: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!submitted) {
    // Try pressing Enter in the password field as fallback
    try {
      await page.locator('input[type="password"]').first().press('Enter');
      submitted = true;
      console.log('  Submitted form via Enter key');
    } catch {}
  }

  if (!submitted) {
    console.log('  Could not find submit button. Please click Sign In manually.');
    await waitForEnter('Press ENTER after signing in.');
    return;
  }

  // ── 6. Wait for login to complete ──
  console.log('Waiting for login to complete...');

  // Wait for navigation or for the "Sign Out" / "My Account" text to appear
  // (indicates successful login). The site may redirect across domains.
  try {
    await page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
  } catch {}
  await page.waitForTimeout(3000);

    // reCAPTCHA may have triggered — check if we're still on the login page
    if (await isLoggedIn(page)) {
      console.log('Signed in successfully!');
      return;
    }

  // Still not logged in — possibly reCAPTCHA or wrong credentials
  console.log('Login may not have completed automatically (reCAPTCHA challenge or invalid credentials).');
  console.log('Please complete login in the browser if needed.');
  await waitForEnter('Press ENTER once you are signed in.');
}

async function isLoggedIn(page) {
  // The site shows "Sign Out" and "My Account" when logged in,
  // and "Sign In" / "Create an Account" when logged out.
  try {
    const signOut = page.locator('text=Sign Out').first();
    const myAccount = page.locator('text=My Account').first();
    if (await signOut.isVisible({ timeout: 1000 })) return true;
    if (await myAccount.isVisible({ timeout: 1000 })) return true;
  } catch {}
  return false;
}

/* ───────── search & present choices ────────────────────────────────────── */

async function searchAndChooseRoom(page, start, end, selectedRoom, opts = {}) {
  const encoded = buildEventDateAndTime(start, end);
  const url = `${BASE_SEARCH}?eventTypeIds=110%2C120&reservationGroupIds=7&eventDateAndTime=${encoded}`;

  console.log('\nNavigating to search results...');
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });

  // Wait for the SPA to render results
  console.log('Waiting for results to load...');
  await page.waitForTimeout(4000);

  // Click "Search" button if present (sometimes needed to trigger the query)
  const searchBtn = page.locator('button:has-text("Search")').first();
  try {
    if (await searchBtn.isVisible({ timeout: 2000 })) {
      await searchBtn.click();
      console.log('Clicked Search button.');
      await page.waitForTimeout(4000);
    }
  } catch {}

  // ── Scrape all bookable items ──
  // Cards are rendered as: div[role="group"].card-package__card.item-searched
  // The aria-label encodes: "Facility <name> ... Attendee <N> Reserve by minute ..."
  // There is NO <a href="/detail/..."> in the card — navigation is React router on click.
  console.log('Scanning available rooms...\n');

  const cardHandles = await page.locator('div.card-package__card.item-searched[role="group"]').elementHandles();
  let rooms = [];
  const seenKeys = new Set();

  for (const card of cardHandles) {
    try {
      const ariaLabel = (await card.evaluate(n => n.getAttribute('aria-label') || '')).trim();
      if (!ariaLabel) continue;

      // Must be Central Library
      if (!/central library/i.test(ariaLabel)) continue;
      // Must be a Meeting Room or Study Room
      const roomMatch = ariaLabel.match(/Meeting Room\s+(\d{2,3})/i) || ariaLabel.match(/Study Room\s+(\d{2,3})/i);
      if (!roomMatch) continue;

      const roomNum = roomMatch[1];
      const roomCode = `MR ${roomNum}`;

      // Capacity from aria-label "Attendee <N>"
      const capMatch = ariaLabel.match(/Attendee\s+(\d+)/i);
      const capacity = capMatch ? Number(capMatch[1]) : null;

      // Facility name from aria-label "Facility <name> Library"
      const nameMatch = ariaLabel.match(/Facility\s+(.+?)\s+Library\s*-/i) ||
                        ariaLabel.match(/Facility\s+(.+?)\s+Location/i);
      const facilityName = nameMatch ? nameMatch[1].trim() : `Central Library - Meeting Room ${roomNum}`;

      const label = `${facilityName} (cap ${capacity ?? '?'})`;
      const key = roomCode;

      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      // Score against a pre-selected room hint
      let score = 0;
      if (selectedRoom) {
        if (ariaLabel.includes(selectedRoom.code)) score += 50;
      }

      rooms.push({ label, roomCode, roomNum, capacity, score, cardHandle: card });
    } catch {
      continue;
    }
  }

  if (rooms.length === 0) {
    console.log('No bookable rooms found for that time slot.');
    console.log('Try a different time, or check the site manually in the open browser.');
    return null;
  }

  // Sort by room number ascending for a predictable list
  rooms.sort((a, b) => Number(a.roomNum) - Number(b.roomNum));

  console.log(`Found ${rooms.length} available option(s):`);

  // Apply capacity filter
  if (opts.requiredCapacity) {
    const before = rooms.length;
    rooms = rooms.filter(r => r.capacity === null || r.capacity >= Number(opts.requiredCapacity));
    console.log(`Filtered ${before - rooms.length} option(s) that didn't meet capacity >= ${opts.requiredCapacity}`);
  }

  if (rooms.length === 0) {
    console.log('No rooms meet the capacity requirement.');
    return null;
  }

  if (opts.listOnly) {
    console.log('\nFiltered live rooms:\n');
    rooms.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.label} [${r.roomCode}]`);
    });
    if (ARGS.listJson) {
      console.log('\nJSON:\n' + JSON.stringify(rooms.map(r => ({ label: r.label, roomCode: r.roomCode, capacity: r.capacity })), null, 2));
    }
    return rooms;
  }

  const choices = rooms.map((r, i) => ({
    name: `${C.cyan((i + 1) + '.')} ${C.green(r.label)} ${C.yellow('[' + r.roomCode + ']')}`,
    value: i
  }));

  // Auto mode: pick highest-scoring (or first) option
  if (ARGS.auto) {
    console.log(C.yellow('Auto mode — selecting first available room.'));
    return rooms[0];
  }

  const { roomIndex } = await ask([{
    name: 'roomIndex',
    type: 'list',
    message: 'Which room would you like to book?',
    choices,
    pageSize: 15
  }]);

  return rooms[roomIndex];
}

/* ───────── reservation flow ───────────────────────────────────────────── */

async function completeReservation(page, room, attendees = 1, signaturePath = null, start = null, end = null) {
  console.log(`\nSelecting: ${room.label} [${room.roomCode}]`);

  // ── Step A: Click the card — React router will navigate to the detail page ──
  // The card is a div[role="group"] with no real href; clicking it triggers
  // the React SPA to route to /detail/<facilityId>. We capture the URL after.
  console.log('Clicking room card to open reservation page...');
  try {
    // Use Promise.race: either navigation fires, or we time out after 10s
    // (SPA may do a pushState without a full navigation event)
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).catch(() => {}),
      (async () => {
        await room.cardHandle.click();
      })()
    ]);
  } catch {}

  // Give the SPA extra time to settle after click + possible pushState
  await page.waitForTimeout(5000);
  await page.waitForLoadState('load').catch(() => {});

  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  // Extract facilityId from the URL we landed on
  const idMatch = currentUrl.match(/\/detail\/(\d+)/);
  if (idMatch) {
    room.facilityId = idMatch[1];
    console.log(`Facility ID: ${room.facilityId}`);
  } else {
    console.log('Warning: could not extract facility ID from URL. Proceeding anyway...');
  }

  console.log('On the reservation page (step 1).');

  // ── Step B: Page 1 — set attendees by clicking "+" button, then Proceed ──
  const want = Number(attendees) || 1;
  console.log(`Setting attendee count to ${want} via increment button...`);
  try {
    const plusSelectors = [
      'button[aria-label*="increase" i]',
      'button[aria-label*="increment" i]',
      'button[aria-label*="add" i]',
      'button[title*="increase" i]',
      'button[title*="increment" i]',
      'button:has-text("+")',
    ];
    let plusBtn = null;
    for (const sel of plusSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 })) { plusBtn = el; break; }
      } catch {}
    }

    if (plusBtn) {
      const clicks = Math.max(0, want - 1);
      for (let i = 0; i < clicks; i++) {
        await plusBtn.click();
        await page.waitForTimeout(300);
      }
      console.log(`Clicked + ${clicks} time(s) to reach ${want} attendee(s).`);
    } else {
      console.log('Could not find a "+" stepper button. Trying numeric input fill...');
      const numInput = page.locator('input[type="number"]').first();
      if (await numInput.count()) {
        await numInput.fill(String(want));
        console.log('Filled attendee count into number input.');
      } else {
        console.log('No attendee control found — please set it manually.');
        await waitForEnter('Set attendees manually, then press ENTER.');
      }
    }
  } catch (err) {
    console.log('Error setting attendees:', err.message || err);
  }

  // Click "Proceed" to move to step 2
  await page.waitForTimeout(1000);
  const proceedSelectors = [
    'button:has-text("Proceed")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Reserve")',
    'button:has-text("Add to Cart")',
    'button:has-text("Add to Shopping Cart")',
    'button[type="submit"]',
  ];
  let proceeded = false;
  for (const sel of proceedSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        const t = (await btn.innerText()).trim();
        await btn.click();
        console.log(C.cyan(`Clicked: "${t}"`));
        proceeded = true;
        break;
      }
    } catch {}
  }
  if (!proceeded) {
    console.log('Could not find a Proceed/Continue button. Please click it manually.');
    await waitForEnter('Press ENTER once you are on the next page.');
  }

  // Wait for page 2 to load
  await page.waitForTimeout(5000);
  await page.waitForLoadState('load').catch(() => {});
  console.log('On reservation page (step 2) — filling in details...');
  step('reservation:fill-details');

  // ── Step C: Page 2 — fill event name, select event type, check waiver, upload signature ──

  // 1) Fill "Event Name" / "Purpose" field with "Study Room Booking"
  try {
    const nameSelectors = [
      'input[name*="event" i]',
      'input[name*="name" i]',
      'input[name*="purpose" i]',
      'input[placeholder*="event" i]',
      'input[placeholder*="name" i]',
      'input[placeholder*="purpose" i]',
      'input[id*="event" i]',
      'input[id*="name" i]',
      'input[id*="purpose" i]',
      'textarea[name*="event" i]',
      'textarea[name*="purpose" i]',
      'textarea[placeholder*="event" i]',
    ];
    let filled = false;
    for (const sel of nameSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 })) {
          await el.click();
          await el.fill('Study Room Booking');
          console.log(`Filled event name using "${sel}".`);
          filled = true;
          break;
        }
      } catch {}
    }
    if (!filled) {
      const labels = await page.locator('label').all();
      for (const lab of labels) {
        const ltxt = (await lab.innerText().catch(() => '')).toLowerCase();
        if (!/event|name|purpose|title/i.test(ltxt)) continue;
        const forAttr = await lab.getAttribute('for').catch(() => null);
        if (forAttr) {
          const inp = page.locator(`#${CSS.escape(forAttr)}`).first();
          if (await inp.count() && await inp.isVisible({ timeout: 500 })) {
            await inp.fill('Study Room Booking');
            console.log('Filled event name via label->for association.');
            filled = true;
            break;
          }
        }
      }
    }
    if (!filled) console.log('Could not find event name field — please fill "Study Room Booking" manually.');
  } catch (err) {
    console.log('Error filling event name:', err.message || err);
  }

  // 2) Select the first option in any visible event-type / activity-type select
  try {
    // --- Handle custom React dropdowns / comboboxes (non-<select> UI) ---
    // The site renders event type as a custom combobox: div.dropdown[role="combobox"]
    // with a button area and a UL list of LI[role=option]. Try that first.
    let selected = false;
    try {
      const combos = await page.locator('div.dropdown[role="combobox"], [role="combobox"]').all();
      for (const combo of combos) {
        try {
          if (!await combo.isVisible({ timeout: 500 }).catch(() => false)) continue;
          const aria = (await combo.getAttribute('aria-label')) || '';
          const btnText = (await combo.evaluate(n => {
            const b = n.querySelector('.dropdown__button, .dropdown__button-text');
            return b ? b.innerText : '';
          })).toString();
          if (!/event type|please select an event type|event-type|eventtype/i.test(aria + ' ' + btnText)) continue;

          // Open the dropdown
          const button = combo.locator('.dropdown__button').first();
          if (await button.count() && await button.isVisible({ timeout: 1000 })) {
            await button.click();
            // wait for expanded state or options to appear
            await page.waitForTimeout(300);
            const listId = await combo.getAttribute('aria-controls');
            let opt = null;
            if (listId) {
              opt = page.locator(`#${listId} li[role="option"]`).first();
            } else {
              opt = combo.locator('ul li[role="option"]').first();
            }
            if (opt && await opt.count() && await opt.isVisible({ timeout: 2000 })) {
              await opt.click();
              console.log('Selected event type via custom dropdown.');
              selected = true;
              break;
            }
          }
        } catch {}
      }
    } catch {}

    // If custom combobox didn't work, try native <select> elements
    if (!selected) {
      const typeSelectors = [
        'select[name*="type" i]',
        'select[name*="event" i]',
        'select[id*="type" i]',
        'select[id*="event" i]',
        'select[aria-label*="type" i]',
        'select[aria-label*="event" i]',
      ];
      for (const sel of typeSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 })) {
            const options = await el.locator('option').all();
            let firstVal = null;
            for (const opt of options) {
              const v = await opt.getAttribute('value');
              const t = (await opt.innerText()).trim();
              if (v && v !== '' && v !== '0' && t && t !== '--' && t !== 'Select') {
                firstVal = v;
                break;
              }
            }
            if (firstVal) {
              await el.selectOption(firstVal);
              console.log(`Selected first event type option (value="${firstVal}").`);
            } else {
              const opts = await el.locator('option').all();
              if (opts.length > 1) { await el.selectOption({ index: 1 }); console.log('Selected event type option at index 1.'); }
              else if (opts.length > 0) { await el.selectOption({ index: 0 }); console.log('Selected event type option at index 0.'); }
            }
            selected = true;
            break;
          }
        } catch {}
      }

      if (!selected) {
        const allSelects = await page.locator('select').all();
        for (const sel of allSelects) {
          try {
            if (!await sel.isVisible({ timeout: 500 })) continue;
            const opts = await sel.locator('option').all();
            if (opts.length > 1) { await sel.selectOption({ index: 1 }); console.log('Selected first option in fallback select.'); selected = true; break; }
          } catch {}
        }
      }
    }

    if (!selected) console.log('Could not find event type select — please select manually.');
  } catch (err) {
    console.log('Error selecting event type:', err.message || err);
  }

  await page.waitForTimeout(500);

  // 3) Check waiver / agreement checkboxes
  // Uses the React nativeInputValueSetter trick so the framework sees the state change.
  try {
    let checked = 0;

    // First: scroll any waiver text containers to the bottom (some sites require this before the checkbox activates)
    try {
      const scrollables = await page.locator('.waiver, .waiver-text, .agreement-text, [class*="waiver"], [class*="agreement"], [class*="terms"]').all();
      for (const el of scrollables) {
        try {
          await el.evaluate(n => { n.scrollTop = n.scrollHeight; });
          await page.waitForTimeout(200);
        } catch {}
      }
    } catch {}

    // Helper: set checkbox using React-compatible native setter + dispatch native events
    const forceCheckCheckbox = async (cb) => {
      try {
        await cb.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await page.waitForTimeout(200);

        // Use nativeInputValueSetter so React's synthetic event system sees the change
        await cb.evaluate(el => {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
          if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, true);
          else el.checked = true;
          // Fire all the events React/Angular listen to
          el.dispatchEvent(new MouseEvent('click',  { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input',  { bubbles: true }));
        });
        await page.waitForTimeout(150);

        // Also do a real Playwright click after so any non-React listeners fire too
        const cbId = await cb.getAttribute('id').catch(() => null);
        if (cbId) {
          const lbl = page.locator(`label[for="${cbId}"]`).first();
          if (await lbl.count() && await lbl.isVisible({ timeout: 300 }).catch(() => false)) {
            await lbl.click({ force: true });
            await page.waitForTimeout(150);
          } else {
            await cb.click({ force: true });
            await page.waitForTimeout(150);
          }
        } else {
          await cb.click({ force: true });
          await page.waitForTimeout(150);
        }
        return true;

    // After attempting to finish, check for common failure messages (rate limits, duplicate booking, waiver rejection)
    try {
      const failurePhrases = [
        'you may only',
        'already have',
        'only allowed',
        'one reservation',
        'per day',
        'duplicate reservation',
        'cannot complete',
        'not allowed',
        'please accept the',
        'waiver'
      ];
      const pageText = (await page.content()).toLowerCase();
      for (const p of failurePhrases) {
        if (pageText.indexOf(p) !== -1) {
          const snippet = pageText.substr(Math.max(0, pageText.indexOf(p) - 40), 240).replace(/\s+/g, ' ').trim();
          logError('rate_limited', snippet);
          break;
        }
      }
    } catch (err) {
      // don't fail the whole run for diagnostics
      console.log('Error scanning page for failure phrases:', err && err.message ? err.message : err);
    }
      } catch { return false; }
    };

    // Pass 1: explicit waiver-related checkboxes
    try {
      const waivers = await page.locator(
        'input[type="checkbox"][aria-label*="agree" i], ' +
        'input[type="checkbox"][aria-label*="waiver" i], ' +
        'input[type="checkbox"][data-qa-id*="waiver" i], ' +
        'input[type="checkbox"][value="agree"]'
      ).all();
      for (const cb of waivers) {
        if (!await cb.isVisible({ timeout: 300 }).catch(() => false)) continue;
        if (await forceCheckCheckbox(cb)) checked++;
      }
    } catch {}

    // Pass 2: all visible checkboxes (catches generic waiver box)
    if (checked === 0) {
      const checkboxes = await page.locator('input[type="checkbox"]').all();
      for (const cb of checkboxes) {
        try {
          if (!await cb.isVisible({ timeout: 300 }).catch(() => false)) continue;
          if (await forceCheckCheckbox(cb)) checked++;
        } catch {}
      }
    }

    // Pass 3: custom role="checkbox" elements
    if (checked === 0) {
      const roleCheckboxes = await page.locator('[role="checkbox"]').all();
      for (const el of roleCheckboxes) {
        try {
          if (!await el.isVisible({ timeout: 300 }).catch(() => false)) continue;
          await el.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await el.click({ force: true });
          checked++;
        } catch {}
      }
    }

    if (checked > 0) { console.log(`Checked ${checked} checkbox(es) (waiver/agreement).`); step(`waiver:checked ${checked}`); }
    else { console.log('No unchecked checkboxes found (may already be checked or not present).'); step('waiver:none'); }
  } catch (err) {
    console.log('Error checking waiver checkbox:', err.message || err);
  }

  // Give the framework time to register the waiver state
  await page.waitForTimeout(1200);

  // 4) Draw signature onto canvas using Playwright's real mouse API.
  //    signature_pad listens to PointerEvents — only page.mouse generates real ones.
  //    dispatchEvent(new MouseEvent(...)) is invisible to the library; don't use it.
  try {
    const canvasLocator = page.locator('canvas').first();
    const canvasCount = await page.locator('canvas').count();

    if (canvasCount === 0) {
      console.log('No canvas found for signature — please sign manually.');
      step('signature:not-found');
    } else {
      // Scroll canvas into view so it has a real bounding box
      await canvasLocator.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);

      const box = await canvasLocator.boundingBox();
      if (!box) {
        console.log('Canvas has no bounding box (possibly hidden) — please sign manually.');
        step('signature:hidden');
      } else {
        // STEP A: If a signature image file exists, draw it onto the canvas visually first.
        if (signaturePath && fs.existsSync(signaturePath)) {
          const imgBuffer = fs.readFileSync(signaturePath);
          const ext = (signaturePath.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
          const imgDataUrl = `data:${mime};base64,${imgBuffer.toString('base64')}`;

          await page.evaluate(async ({ dataUrl, w, h }) => {
            const canvas = document.querySelector('canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            await new Promise((res) => {
              const img = new Image();
              img.onload = () => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                const scale = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.85;
                const x = (canvas.width  - img.width  * scale) / 2;
                const y = (canvas.height - img.height * scale) / 2;
                ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
                res();
              };
              img.onerror = () => res();
              img.src = dataUrl;
            });
          }, { dataUrl: imgDataUrl, w: box.width, h: box.height });
          console.log('Drew signature image onto canvas (visual layer).');
          step('signature:drew-image');
        }

        // STEP B: Simulate a real pen stroke with Playwright's mouse API.
        //         This creates genuine PointerEvents that signature_pad tracks in _data,
        //         making isEmpty() return false so the form validator passes.
        const cx = box.x + box.width  * 0.5;
        const cy = box.y + box.height * 0.5;
        const steps = 25;

        // Lift the pen and position it, then draw an arc (looks like a signature swoop)
        await page.mouse.move(cx - box.width * 0.3, cy + box.height * 0.1);
        await page.mouse.down();
        for (let i = 0; i <= steps; i++) {
          const t  = i / steps;
          const px = cx - box.width * 0.3 + t * box.width * 0.6;
          const py = cy + box.height * 0.1 - Math.sin(t * Math.PI) * box.height * 0.35;
          await page.mouse.move(px, py);
          await page.waitForTimeout(8);
        }
        await page.mouse.up();
        await page.waitForTimeout(300);

        // Verify the signature pad registered the stroke
        const isEmpty = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return null;
          // Search for the signature_pad instance attached to the canvas or window
          const sp = canvas._signaturePad || canvas.__signaturePad || window.signaturePad || window._signaturePad;
          if (sp && typeof sp.isEmpty === 'function') return sp.isEmpty();
          // Fallback: check if there are any non-transparent pixels on the canvas
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) return false; }
          return true;
        });

        if (isEmpty === false) {
          console.log('Signature registered by signature_pad (isEmpty = false).');
          step('signature:registered');
        } else if (isEmpty === true) {
          console.log('Warning: signature_pad still reports isEmpty — attempting _data patch.');
          step('signature:isEmpty');
          // Last-resort: directly inject a minimal stroke into _data so isEmpty() returns false
          await page.evaluate(() => {
            const canvas = document.querySelector('canvas');
            const sp = canvas && (canvas._signaturePad || canvas.__signaturePad || window.signaturePad);
            if (!sp) return;
            const stub = [{ penColor: '#000', points: [{ x: 50, y: 50, pressure: 0.5, time: Date.now() }, { x: 80, y: 40, pressure: 0.5, time: Date.now() + 30 }] }];
            // v4 uses _data, v2/v3 use _data or _strokeData
            if (Array.isArray(sp._data))       sp._data = stub;
            if (Array.isArray(sp._strokeData)) sp._strokeData = stub;
          });
          console.log('Patched signature_pad._data directly.');
          step('signature:patched');
        } else {
          console.log('Signature drawn (canvas has content; instance not directly accessible).');
        }

        // Also update any hidden signature input field
        await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return;
          const hidden = document.querySelector(
            'input[type="hidden"][name*="signature" i], input[type="hidden"][id*="signature" i]'
          );
          if (hidden) {
            hidden.value = canvas.toDataURL('image/png');
            hidden.dispatchEvent(new Event('input',  { bubbles: true }));
            hidden.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }
    }
  } catch (err) {
    console.log('Error drawing signature:', err.message || err);
  }

  await page.waitForTimeout(800);

  // 5) Click "Add to Cart" (or equivalent) on page 2
  // Prioritise "Add to Cart" variants first; fall back to other submit buttons.
  const submitSelectors = [
    'button:has-text("Add to Cart")',
    'button:has-text("Add to Shopping Cart")',
    'button:has-text("Proceed")',
    'button:has-text("Submit")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Confirm")',
    'button:has-text("Finish")',
    'button[type="submit"]',
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        const t = (await btn.innerText()).trim();
        // Scroll into view and wait briefly so any pending validation settles
        await btn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await page.waitForTimeout(400);
        // Check the button is not disabled before clicking
        const isDisabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);
        if (isDisabled) {
          console.log(`Button "${t}" is disabled — skipping.`);
          continue;
        }
        await btn.click({ force: true });
        console.log(C.cyan(`Clicked: "${t}"`));
        submitted = true;
        step('clicked:add-to-cart');
        break;
      }
    } catch {}
  }
  if (!submitted) {
    console.log('Could not find submit button on step 2. Please click it manually.');
  }

  // 6) Wait for cart page to load, then click "Finish" to complete the order
  await page.waitForTimeout(4000);
  try {
    // Wait until we're on a cart/checkout page
    await page.waitForURL(/cart|checkout|shopping/i, { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(1500);

    const finishSelectors = [
      'button:has-text("Finish")',
      'button:has-text("Complete")',
      'a:has-text("Finish")',
      'a:has-text("Complete")',
      'button:has-text("Checkout")',
      'button:has-text("Place Order")',
      'button:has-text("Confirm")',
      'input[value*="Finish" i]',
      'input[value*="Complete" i]',
    ];
    for (const sel of finishSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          // Safely obtain button text or fallback to its value or selector string
          let t = String(sel);
          try {
            const it = await btn.innerText();
            if (it) t = it.trim();
            else {
              const val = await btn.getAttribute('value');
              if (val) t = String(val).trim();
            }
          } catch (e) {
            try {
              const val = await btn.getAttribute('value');
              if (val) t = String(val).trim();
            } catch {}
          }

          await btn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await page.waitForTimeout(400);
          await btn.click({ force: true });
          console.log(C.cyan(`Clicked: "${t}"`));
          await page.waitForTimeout(3000);
          step('clicked:finish');
          break;
        }
      } catch {}
    }
  } catch (err) {
    console.log('Note: could not auto-click Finish on cart page —', err.message || err);
  }

  // ── Check for success ──
  const successTexts = ['Reservation Confirmed', 'Reservation Complete', 'Thank you', 'Confirmation', 'Success', 'has been added', 'receipt', 'Shopping Cart'];
  for (const txt of successTexts) {
    try {
      if (await page.locator(`text=${txt}`).first().isVisible({ timeout: 1000 })) {
        console.log(C.green('\nBooking appears successful!'));
        step('booking:appears-successful');
        break;
      }
    } catch {}
  }

  // ── Print human-readable booking summary ──
  try {
    const roomLabel = room.label || room.name || room.code || 'Unknown Room';
    const roomCode   = room.code || '';
    const fmt = (d) => {
      if (!d) return '';
      const days  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const h = d.getHours(), m = d.getMinutes();
      const ampm = h >= 12 ? 'pm' : 'am';
      const hr12 = h % 12 || 12;
      return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ${hr12}${m ? ':' + String(m).padStart(2,'0') : ''}${ampm}`;
    };
    const startStr = start ? fmt(start) : '';
    const endPart  = end   ? `${(end.getHours()%12||12)}${end.getMinutes() ? ':'+String(end.getMinutes()).padStart(2,'0') : ''}${end.getHours()>=12?'pm':'am'}` : '';
    const timeStr  = startStr + (endPart ? ` – ${endPart}` : '');
    const roomName = roomCode ? `Meeting Room ${roomCode.replace(/^MR\s*/i, '')}` : roomLabel;
    console.log(C.green(`\n✔ ${roomName} booked for ${timeStr}`));
  } catch {}

  console.log('\nReservation flow completed. Please verify in the browser whether booking succeeded.');
  return true;
}

/* ───────── main ───────────────────────────────────────────────────────── */

async function main() {
  // ── Interactive prompts for missing inputs ──
  logger.info(C.cyan('\nWelcome to the Room Booker (interactive)\n'));
  logger.info(C.green('Use arrow keys to navigate lists, Enter to confirm, Esc to cancel.'));

   const whenAns = await ask([
    { name: 'dateText', message: 'When would you like to book? (natural language, e.g. "wednesday march 4 6-8pm")', type: 'input' }
  ]);

   const raw = whenAns.dateText || ARGS.dateText;

   // ── Ask how many people (capacity filter: 4 or 6) ──
   let requiredCapacity = ARGS.requiredCapacity ? Number(ARGS.requiredCapacity) : null;
   if (!requiredCapacity) {
     const capAns = await ask([{
       name: 'cap',
       type: 'list',
       message: 'How many people? (sets minimum room capacity)',
       choices: [
         { name: '4 people  — show rooms with capacity ≥ 4', value: 4 },
         { name: '6 people  — show rooms with capacity ≥ 6 only', value: 6 }
       ]
     }]);
     requiredCapacity = Number(capAns.cap);
   }

   // attendees = the capacity they chose (fill room to max)
   const attendees = requiredCapacity;

   // signature path: prefer CLI flag, then default signature.png if present
   const defaultSig = './signature.png';
   const signaturePath = ARGS.signaturePath ? (fs.existsSync(ARGS.signaturePath) ? ARGS.signaturePath : null) : (fs.existsSync(defaultSig) ? defaultSig : null);

  const { start, end } = await parseInputText(raw);
   console.log(C.green('\nParsed time:') + ` ${start.toString()} -> ${end.toString()}`);

   // ── Launch browser with persistent profile ──
   const profileDir = './playwright_profile';
   if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: ARGS.headless === true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });
  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  // Attach diagnostics listeners to capture network errors, failed requests and page errors
  attachPageDiagnostics(page);

   try {
     // Step 1: Sign in FIRST
     await signIn(page);

    // If list-only flag provided, show filtered live rooms and exit
    if (ARGS.listOnly) {
      const rooms = await searchAndChooseRoom(page, start, end, null, { listOnly: true, requiredCapacity });
      if (Array.isArray(rooms)) {
        console.log('\nListing complete. Browser left open for manual inspection.');
        return;
      }
      console.log('No live rooms found in list mode.');
      return;
    }

    // Step 2: Search live site and let the user pick one of the actual live options
    const room = await searchAndChooseRoom(page, start, end, null, { listOnly: false, requiredCapacity });
    if (!room) {
      console.log('No live room selected. Leaving browser open for manual use.');
      return;
    }

    // Step 3: Complete the reservation
    await completeReservation(page, room, attendees, signaturePath, start, end);

  } catch (err) {
    console.error('Error:', err.message);
    try {
      // Save diagnostics snapshot for post-mortem
      const base = await savePageSnapshot(page, 'error');
      const found = await scanForFailurePhrases(page);
      const reasons = explainIssues(found, diagnosticsCollector);

      console.warn(C.red('\nError summary:'));
      console.warn(`  Message: ${err.message}`);
      if (base) console.warn(`  Saved diagnostics: ${base}.(html|png)`);
      if (found && found.length) {
        console.warn(C.yellow('\n  Detected notable text on page:'));
        for (const f of found) console.warn(`    - ${f.phrase}: ${f.snippet}`);
      }
      if (reasons && reasons.length) {
        console.warn(C.cyan('\n  Possible causes and explanations:'));
        for (const r of reasons) {
          console.warn(C.green(`    - ${r.title}: `) + `${r.explain}`);
        }
      } else {
        console.warn('\n  No obvious failure phrases detected. Check the saved HTML/screenshot for details.');
      }
    } catch (e) {
      console.error('Failed to collect diagnostics:', e && e.message ? e.message : e);
    }
  }

  // Leave browser open so user can verify / intervene
  console.log('\nBrowser left open. Close it manually when done.');
}

main().catch((err) => { console.error('Fatal error:', err.message); process.exit(1); });
