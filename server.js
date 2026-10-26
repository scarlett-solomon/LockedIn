'use strict';

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const wa = require('./whatsapp');
const insights = require('./insights');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Secuirty functions
function loadJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16 && fromEnv !== 'change-me') return fromEnv;
  const file = path.join(__dirname, '.jwt-secret');
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s.length >= 32) return s; } catch { /* make one below */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  console.log('  No JWT_SECRET in .env, so a random one was saved to .jwt-secret (keep that file private).');
  return s;
}
const JWT_SECRET = loadJwtSecret();

// Limit guessess 
const attempts = new Map();
function tooManyAttempts(req, who, max = 10) {
  const key = `${req.ip}|${String(who || '').toLowerCase()}`;
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  a.push(now); attempts.set(key, a);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some(t => now - t < 15 * 60 * 1000)) attempts.delete(k);
  return a.length > max;
}

// Twilio signs 
function validTwilio(req) {
  const tokenKey = process.env.TWILIO_TOKEN;
  if (!tokenKey) return true;   // dry-run mode, no real WhatsApp connected
  const base = process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL.replace(/\/$/, '')
    : `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
  const body = req.body || {};
  const data = base + req.originalUrl + Object.keys(body).sort().map(k => k + body[k]).join('');
  const expected = crypto.createHmac('sha1', tokenKey).update(data).digest('base64');
  const got = String(req.headers['x-twilio-signature'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

db.init();


app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',   
  });
  next();
});
app.use(express.json({ limit: '200kb' }));


app.get('/uploads/:name', (req, res) => {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
  let payload;
  try { payload = jwt.verify(raw, JWT_SECRET); } catch { return res.status(401).send('Login required'); }
  const user = db.findUserById(payload.id);
  const name = path.basename(String(req.params.name));
  if (!user || !user.data.files.some(f => f.filename === name)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'private, max-age=300');
  res.sendFile(path.join(UPLOAD_DIR, name));
});
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' }[file.mimetype.toLowerCase()] || '.bin';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Only images and PDFs are allowed'), ok);
  },
});

// More helpers
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function getUser(req) {
  return db.findUserById(req.user.id);
}

// Validation helpers
const HAS_SPACE = /\s/;
const USERNAME_RE = /^[A-Za-z0-9._-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}


app.post('/api/register', (req, res) => {
  if (tooManyAttempts(req, 'register', 40)) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
  const { username, password, name } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const u = String(username);
  const p = String(password);
  if (HAS_SPACE.test(u)) {
    return res.status(400).json({ error: 'Username cannot contain spaces' });
  }
  if (HAS_SPACE.test(p)) {
    return res.status(400).json({ error: 'Password cannot contain spaces' });
  }
  if (u.length < 2 || u.length > 30) {
    return res.status(400).json({ error: 'Username must be 2–30 characters' });
  }
  if (!USERNAME_RE.test(u)) {
    return res.status(400).json({ error: 'Username can only use letters, numbers, . _ -' });
  }
  if (p.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (db.findUserByUsername(u)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const hash = bcrypt.hashSync(p, 10);
  const user = db.createUser({
    username: u,
    passwordHash: hash,
    name: (name || u).trim() || 'Student',
  });

  const token = signToken(user);
  res.status(201).json({
    token,
    user: { id: user.id, username: user.username, name: user.data.name },
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (HAS_SPACE.test(String(username))) {
    return res.status(400).json({ error: 'Username cannot contain spaces' });
  }

  if (tooManyAttempts(req, username)) return res.status(429).json({ error: 'Too many tries. Please wait 15 minutes and try again.' });
  const user = db.findUserByUsername(username);
  if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, name: user.data.name },
  });
});

app.get('/api/me', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, name: user.data.name });
});


app.get('/api/state', auth, (req, res) => {
  const state = db.getFullState(req.user.id);
  if (!state) return res.status(404).json({ error: 'User not found' });
  state.academics = insights.academicsInsights(db.findUserById(req.user.id));   
  res.json(state);
});


app.patch('/api/profile', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const name = (req.body?.name || '').trim() || 'Student';
  user.data.name = name;
  db.updateUser(user);
  res.json({ name });
});

// Links
app.put('/api/links/:linkId', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.data.links[req.params.linkId] = (req.body?.url || '').trim();
  db.updateUser(user);
  res.json({ ok: true });
});

// Timeline
app.post('/api/timeline', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const label = String(req.body?.label || '').trim();
  const date = String(req.body?.date || '').trim();
  if (!label) return res.status(400).json({ error: 'Label required' });
  if (!validDate(date)) return res.status(400).json({ error: 'Date must be a valid YYYY-MM-DD' });

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const item = {
    id: db.nextId(user, 'timeline'),
    label,
    date,
    done: false,
  };
  user.data.timeline.push(item);
  db.updateUser(user);
  res.status(201).json({ ...item, when: MONTHS[Number(date.slice(5, 7)) - 1] });
});

app.patch('/api/timeline/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const item = user.data.timeline.find(t => t.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  item.done = !!req.body?.done;
  db.updateUser(user);
  res.json({ ok: true });
});

app.delete('/api/timeline/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const before = user.data.timeline.length;
  user.data.timeline = user.data.timeline.filter(t => t.id !== Number(req.params.id));
  if (user.data.timeline.length === before) return res.status(404).json({ error: 'Not found' });
  db.updateUser(user);
  res.json({ ok: true });
});

// Vault
app.post('/api/files', auth, upload.single('file'), (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const name = (req.body?.name || (req.file && req.file.originalname) || 'Untitled document').trim();
  const expires = req.body?.expires || null;
  const filename = req.file ? req.file.filename : null;

  const file = {
    id: db.nextId(user, 'file'),
    name,
    expires: expires || null,
    filename,
  };
  user.data.files.push(file);
  db.updateUser(user);

  res.status(201).json({
    id: file.id,
    name: file.name,
    expires: file.expires,
    img: filename ? '/uploads/' + filename : null,
  });
});

app.patch('/api/files/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const file = user.data.files.find(f => f.id === Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Not found' });

  if (req.body?.name != null) file.name = String(req.body.name).trim() || file.name;
  if (req.body?.expires !== undefined) {
    file.expires = req.body.expires === '' || req.body.expires == null ? null : req.body.expires;
  }
  db.updateUser(user);

  res.json({
    id: file.id,
    name: file.name,
    expires: file.expires,
    img: file.filename ? '/uploads/' + file.filename : null,
  });
});

app.delete('/api/files/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const idx = user.data.files.findIndex(f => f.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const file = user.data.files[idx];
  if (file.filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)); } catch {}
  }
  user.data.files.splice(idx, 1);
  db.updateUser(user);
  res.json({ ok: true });
});

// Money Hub
const numOr = (v, min = 0, max = 1e9) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const txt = (v, n = 80) => String(v ?? '').trim().slice(0, n);
const dateOrNull = v => (v && validDate(String(v)) ? String(v) : null);

app.put('/api/money/mode', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const mode = req.body?.mode;
  if (!['nsfas', 'bursary', 'self'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be nsfas, bursary or self' });
  }
  user.data.fundingMode = mode;
  db.updateUser(user);
  res.json({ fundingMode: mode });
});

app.put('/api/money/nsfas-progress', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  const p = {
    enrolled: numOr(b.enrolled, 0, 60),
    passed: numOr(b.passed, 0, 60),
    failed: numOr(b.failed, 0, 60),
    minRate: numOr(b.minRate, 1, 100) ?? 55,
  };
  if (p.enrolled != null && (p.passed || 0) + (p.failed || 0) > p.enrolled) {
    return res.status(400).json({ error: 'Passed + failed cannot be more than the modules you are taking' });
  }
  user.data.nsfasProgress = p;
  db.updateUser(user);
  res.json(p);
});

app.put('/api/money/bursary', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  user.data.bursary = {
    sponsor: txt(b.sponsor),
    contact: txt(b.contact),
    covers: txt(b.covers, 120),
    endDate: dateOrNull(b.endDate),
    minAvg: numOr(b.minAvg, 0, 100),
    currentAvg: numOr(b.currentAvg, 0, 100),
    minModules: numOr(b.minModules, 0, 60),
    modulesPassed: numOr(b.modulesPassed, 0, 60),
  };
  db.updateUser(user);
  res.json(user.data.bursary);
});

app.put('/api/money/self', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  user.data.selfFunded = {
    feesTotal: numOr(b.feesTotal),
    feesPaid: numOr(b.feesPaid),
    instalments: list(b.instalments, 12).map((x, i) => ({
      id: i + 1, label: txt(x.label, 40) || `Instalment ${i + 1}`,
      amount: numOr(x.amount) || 0, due: dateOrNull(x.due), paid: !!x.paid,
    })).filter(x => x.due),
    income: list(b.income, 10).map((x, i) => ({ id: i + 1, label: txt(x.label, 40) || 'Income', amount: numOr(x.amount) || 0 })),
    budget: list(b.budget, 12).map((x, i) => ({ id: i + 1, category: txt(x.category, 40) || 'Other', amount: numOr(x.amount) || 0 })),
    _next: 100,
  };
  db.updateUser(user);
  res.json(user.data.selfFunded);
});

app.put('/api/money/wallet', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  const day = Math.round(numOr(b.payoutDay, 1, 28) ?? 25);
  user.data.wallet = { balance: numOr(b.balance), weeklySpend: numOr(b.weeklySpend), payoutDay: day };
  db.updateUser(user);
  res.json(user.data.wallet);
});

// Money Hub 
app.patch('/api/money/nsfas', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const step = Number(req.body?.nsfasStep);
  if (!Number.isInteger(step) || step < 0 || step > 3) {
    return res.status(400).json({ error: 'nsfasStep must be 0–3' });
  }
  user.data.nsfasStep = step;
  db.updateUser(user);
  res.json({ nsfasStep: step });
});

app.put('/api/money/amounts', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const m = req.body || {};
  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  user.data.money = {
    tuition: num(m.tuition),
    owing: num(m.owing),
    accommodation: num(m.accommodation),
    food: num(m.food),
    books: num(m.books),
  };
  db.updateUser(user);
  res.json({ ok: true });
});

// Log what happened to one month's payout
app.put('/api/payouts/:month', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const month = String(req.params.month);
  const status = req.body?.status;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Month must look like 2026-10' });
  if (month > insights.todayISO().slice(0, 7)) return res.status(400).json({ error: 'That payout has not happened yet' });
  if (!['received', 'missing', 'clear'].includes(status)) {
    return res.status(400).json({ error: 'status must be received, missing or clear' });
  }
  if (!user.data.payoutLog) user.data.payoutLog = {};
  if (!user.data.payoutDates) user.data.payoutDates = {};
  if (status === 'clear') delete user.data.payoutLog[month];
  else user.data.payoutLog[month] = status;
  
  if (status === 'received' && month === insights.todayISO().slice(0, 7)) user.data.payoutDates[month] = insights.todayISO();
  else delete user.data.payoutDates[month];
  db.updateUser(user);
  res.json({ payoutLog: user.data.payoutLog });
});

// Tasks
app.post('/api/tasks', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { title, due, weight } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });

  const task = {
    id: db.nextId(user, 'task'),
    title: String(title).trim(),
    due: due || new Date().toISOString().slice(0, 10),
    weight: Number(weight) || 0,
    done: false,
  };
  user.data.tasks.push(task);
  db.updateUser(user);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const t = user.data.tasks.find(x => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Not found' });

  if (req.body?.done != null) {
    t.done = !!req.body.done;
    
    if (t.done) t.completedAt = insights.todayISO();
    else delete t.completedAt;
  }
  if (req.body?.title != null) t.title = String(req.body.title).trim();
  if (req.body?.due != null) t.due = req.body.due;
  if (req.body?.weight != null) t.weight = Number(req.body.weight);
  db.updateUser(user);
  res.json(t);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const before = user.data.tasks.length;
  user.data.tasks = user.data.tasks.filter(t => t.id !== Number(req.params.id));
  if (user.data.tasks.length === before) return res.status(404).json({ error: 'Not found' });
  db.updateUser(user);
  res.json({ ok: true });
});

// Timetable
app.post('/api/timetable', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { title, time, room, days } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title required' });
  const dayList = [...new Set((Array.isArray(days) ? days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!dayList.length) return res.status(400).json({ error: 'Pick at least one day' });

  const cls = {
    id: db.nextId(user, 'timetable'),
    title: String(title).trim(),
    time: time || '09:00',
    room: (room || '').trim(),
    days: dayList,
  };
  user.data.timetable.push(cls);
  db.updateUser(user);
  res.status(201).json(cls);
});

app.delete('/api/timetable/:id', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const before = user.data.timetable.length;
  user.data.timetable = user.data.timetable.filter(c => c.id !== Number(req.params.id));
  if (user.data.timetable.length === before) return res.status(404).json({ error: 'Not found' });
  db.updateUser(user);
  res.json({ ok: true });
});

// Modules and marks 
class BadModules extends Error {}

function cleanModules(input) {
  if (!Array.isArray(input)) throw new BadModules('modules must be a list');
  if (input.length > 12) throw new BadModules('You can add up to 12 modules');
  const ids = list => list.map(x => Number(x && x.id)).filter(n => Number.isInteger(n) && n > 0);
  let nextModule = Math.max(0, ...ids(input)) + 1;
  const usedModules = new Set(), names = new Set();

  return input.map(m => {
    const name = txt(m && m.name, 40);
    if (!name) throw new BadModules('Every module needs a name');
    if (names.has(name.toLowerCase())) throw new BadModules(`You already have a module called ${name}`);
    names.add(name.toLowerCase());

    let id = Number(m.id);
    if (!Number.isInteger(id) || id < 1 || usedModules.has(id)) id = nextModule++;
    usedModules.add(id);

    const raw = Array.isArray(m.assessments) ? m.assessments : [];
    if (raw.length > 12) throw new BadModules(`${name}: you can add up to 12 tests, assignments and exams`);
    let nextA = Math.max(0, ...ids(raw)) + 1;
    const usedA = new Set();
    const assessments = raw.map((a, i) => {
      const weight = a.weight === '' || a.weight == null ? NaN : Number(a.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new BadModules(`${name}: give each test or assignment a weight between 0 and 100`);
      let mark = null;
      if (a.mark !== '' && a.mark != null) {
        mark = Number(a.mark);
        if (!Number.isFinite(mark) || mark < 0 || mark > 100) throw new BadModules(`${name}: marks must be between 0 and 100`);
      }
      let aid = Number(a.id);
      if (!Number.isInteger(aid) || aid < 1 || usedA.has(aid)) aid = nextA++;
      usedA.add(aid);
      return { id: aid, name: txt(a.name, 40) || `Assessment ${i + 1}`, weight, mark };
    });
    const total = assessments.reduce((s, a) => s + a.weight, 0);
    if (total > 100.0001) throw new BadModules(`${name}: the weights add up to ${Math.round(total * 10) / 10}%. They can't be more than 100%`);
    return { id, name, assessments };
  });
}

app.put('/api/modules', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let modules;
  try { modules = cleanModules(req.body?.modules); }
  catch (e) {
    if (e instanceof BadModules) return res.status(400).json({ error: e.message });
    throw e;
  }
  user.data.modules = modules;
  db.updateUser(user);
  res.json({ modules, academics: insights.academicsInsights(user) });
});

// Calculator 
app.put('/api/calc', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { course, avg, examWeight } = req.body || {};
  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  user.data.calc = {
    course: (course || '').trim(),
    avg: num(avg),
    examWeight: num(examWeight),
  };
  db.updateUser(user);
  res.json({ ok: true });
});

// WhatsApp
app.put('/api/whatsapp', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const phone = wa.normalizePhone(req.body?.phone);
  if (phone && (phone.length < 9 || phone.length > 15)) {
    return res.status(400).json({ error: 'Enter a valid cellphone number, e.g. 082 123 4567' });
  }
  const conflict = db.getAllUsers().find(u => u.id !== user.id && u.data.whatsapp && phone && u.data.whatsapp.phone === phone);
  if (conflict) return res.status(409).json({ error: 'That number is linked to another account' });

  const cfg = wa.ensureWA(user);
  cfg.phone = phone;
  cfg.enabled = !!req.body?.enabled && !!phone;
  cfg.wellness = req.body?.wellness !== false;
  db.updateUser(user);
  res.json(cfg);
});

// Twilio calls this when a student replies on WhatsApp
app.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  if (!validTwilio(req)) return res.status(403).send('Forbidden');
  let reply;
  try {
    reply = await wa.handleIncoming(req.body.From, req.body.Body);   
  } catch (e) {
    console.error('Webhook error:', e);
    reply = 'Sorry, something went wrong. Please try again.';
  }
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${wa.xml(reply)}</Message></Response>`);
});

// Insights
app.get('/api/insights', auth, (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(insights.compute(user));
});

app.post('/api/insights/plan', auth, async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { plan, source } = await insights.weeklyPlan(user);
  res.json({ plan, source });
});

app.post('/api/insights/plan/send', auth, async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cfg = wa.ensureWA(user);
  if (!cfg.phone) return res.status(400).json({ error: 'Save your WhatsApp number first (tap your avatar)' });
  const cached = insights.getLastPlan(user.id) || await insights.weeklyPlan(user);
  const ok = await wa.sendWhatsApp(cfg.phone, cached.plan);
  if (!ok) return res.status(502).json({ error: 'Could not send. Did you join the Twilio sandbox?' });
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  LockedIn running at http://localhost:${PORT}\n`);
  wa.startScheduler();
});