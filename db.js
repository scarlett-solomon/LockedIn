'use strict';

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data.json');

/** In-memory store, persisted to data.json after every write. */
let store = { users: [], nextUserId: 1 };

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not read data.json, starting fresh:', e.message);
    store = { users: [], nextUserId: 1 };
  }
  migrateTimelines();
  migrateMoney();
  migrateTimetable();
  migrateModules();
}

/** "2026-10" for this month (offset 0), last month (-1) and so on. */
function monthKey(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Money Hub fields every account needs. Amounts and dates only: never bank or card numbers. */
function moneyDefaults(demo) {
  return {
    // One entry per month the student has logged: { '2026-09': 'received', '2026-08': 'missing' }.
    // A month with no entry is worked out from the date (expected, late or not recorded).
    payoutLog: demo ? { [monthKey(-1)]: 'received', [monthKey(-2)]: 'missing', [monthKey(-3)]: 'received' } : {},
    // The day each payout actually landed ({ '2026-09': '2026-09-27' }). The app learns your pattern from this.
    payoutDates: demo ? { [monthKey(-1)]: `${monthKey(-1)}-27`, [monthKey(-3)]: `${monthKey(-3)}-28` } : {},
    fundingMode: null,   // 'nsfas' | 'bursary' | 'self' (null = student has not picked yet)
    // Pass rate NSFAS asks for. Editable because it differs for first-time vs continuing students.
    nsfasProgress: demo ? { enrolled: 6, passed: 2, failed: 0, minRate: 55 }
                        : { enrolled: null, passed: null, failed: null, minRate: 55 },
    bursary: demo
      ? { sponsor: 'Sample Bursary Trust', contact: '', covers: 'Tuition + allowance', endDate: null,
          minAvg: 62, currentAvg: 66, minModules: null, modulesPassed: null }
      : { sponsor: '', contact: '', covers: '', endDate: null, minAvg: null, currentAvg: null, minModules: null, modulesPassed: null },
    selfFunded: demo
      ? { feesTotal: 45000, feesPaid: 30000,
          instalments: [
            { id: 1, label: 'Instalment 2', amount: 7500, due: inDays(5), paid: false },
            { id: 2, label: 'Instalment 3', amount: 7500, due: inDays(35), paid: false },
          ],
          income: [{ id: 1, label: 'Parents', amount: 3000 }, { id: 2, label: 'Part-time job', amount: 1200 }],
          budget: [{ id: 1, category: 'Rent', amount: 2200 }, { id: 2, category: 'Food', amount: 1200 },
                   { id: 3, category: 'Transport', amount: 400 }, { id: 4, category: 'Data', amount: 300 }],
          _next: 5 }
      : { feesTotal: null, feesPaid: null, instalments: [], income: [], budget: [], _next: 1 },
    // payoutDay = day of the month money normally lands (1-28). balance/weeklySpend feed the forecast.
    wallet: demo ? { balance: 600, weeklySpend: 350, payoutDay: 25 } : { balance: null, weeklySpend: null, payoutDay: 25 },
  };
}

/** Give accounts created before the Money Hub update the new (empty) fields. */
function migrateMoney() {
  let changed = false;
  const LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  for (const u of store.users) {
    if (!u.data) continue;
    // old fixed payout log ({ month: 'October', status }) -> one entry per real month
    if (u.data.payoutLog === undefined && Array.isArray(u.data.payouts)) {
      const now = new Date();
      const log = {};
      for (const p of u.data.payouts) {
        const m = LONG.indexOf(p.month);
        if (m < 0 || !['received', 'missing'].includes(p.status)) continue;
        const year = m > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
        log[`${year}-${pad(m + 1)}`] = p.status;
      }
      u.data.payoutLog = log;
      changed = true;
    }
    if (u.data.payouts !== undefined) { delete u.data.payouts; changed = true; }
    const blank = moneyDefaults(false);
    for (const k of Object.keys(blank)) {
      if (u.data[k] === undefined) { u.data[k] = blank[k]; changed = true; }
    }
  }
  if (changed) save();
}

/**
 * Modules replace the old one-course calculator. A student who had filled the old calculator in
 * keeps that course as their first module: the "mark so far" becomes one assessment, the exam another.
 * Shape: modules = [{ id, name, assessments: [{ id, name, weight, mark }] }]   (weight and mark are percentages)
 */
function migrateModules() {
  let changed = false;
  for (const u of store.users) {
    if (!u.data || u.data.modules !== undefined) continue;
    const c = u.data.calc || {};
    const w = Number(c.examWeight);
    if (c.course && c.avg != null && w > 0 && w < 100) {
      u.data.modules = [{ id: 1, name: String(c.course).trim().slice(0, 40), assessments: [
        { id: 1, name: 'Mark so far', weight: 100 - w, mark: Number(c.avg) },
        { id: 2, name: 'Exam', weight: w, mark: null },
      ] }];
    } else {
      u.data.modules = [];
    }
    changed = true;
  }
  if (changed) save();
}

/** Old classes had no day. Treat them as Monday to Friday so nobody loses their timetable. */
function migrateTimetable() {
  let changed = false;
  for (const u of store.users) {
    for (const c of (u.data && u.data.timetable) || []) {
      if (!Array.isArray(c.days) || !c.days.length) { c.days = [1, 2, 3, 4, 5]; changed = true; }
    }
  }
  if (changed) save();
}


function classesOn(user, date) {
  const [dayNum, month, year] = date.split(/[-/]/);
  const day = new Date(`${year}-${month}-${dayNum}T12:00:00`).getDay();
  return ((user.data && user.data.timetable) || [])
    .filter(c => !c.days || c.days.includes(day))
    .sort((a, b) => a.time.localeCompare(b.time));
}   


function migrateTimelines() {
  const year = new Date().getFullYear();
  let changed = false;
  for (const u of store.users) {
    for (const t of (u.data && u.data.timeline) || []) {
      if (!t.date) {
        const m = Math.max(0, MONTHS.indexOf(t.when));
        t.date = `${year}-${pad(m + 1)}-01`;
        changed = true;
      }
    }
  }
  if (changed) save();
}

function save() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Failed to write data.json:', e.message);
  }
}

function init() {
  load();
}

function pad(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function inDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toISO(d);
}


function defaultData(name) {
  const y = new Date().getFullYear();
  return {
    name: name || 'Student',
    links: {},
    timeline: [
      { id: 1, label: 'Re-register for modules', date: `${y}-01-15`, done: false },
      { id: 2, label: 'Mid-year exams and results', date: `${y}-07-15`, done: false },
      { id: 3, label: 'Renew accommodation', date: `${y}-10-15`, done: false },
      { id: 4, label: 'Graduation clearance', date: `${y}-11-15`, done: false },
    ],
    files: [
      { id: 1, name: 'Certified ID copy', expires: inDays(6), filename: null },
      { id: 2, name: 'Matric results', expires: null, filename: null },
      { id: 3, name: 'Official transcript', expires: null, filename: null },
      { id: 4, name: 'Proof of residence', expires: null, filename: null },
      { id: 5, name: 'Income affidavit', expires: inDays(45), filename: null },
    ],
    nsfasStep: 3,
    money: { tuition: null, owing: null, accommodation: null, food: null, books: null },
    tasks: [
      { id: 1, title: 'Statistics test', due: inDays(2), weight: 30, done: false },
      { id: 2, title: 'Economics essay', due: inDays(5), weight: 20, done: false },
      { id: 3, title: 'Law quiz', due: inDays(7), weight: 10, done: false },
    ],
    modules: [],   // the student adds these the first time they open Academics
    timetable: [
      { id: 1, title: 'Statistics tutorial', time: '10:00', room: 'B2', days: [1, 3] },
      { id: 2, title: 'Economics lecture', time: '13:00', room: 'Hall 4', days: [2, 4] },
    ],
    _nextIds: { file: 6, task: 4, timetable: 3, payout: 4, timeline: 5 },
    ...moneyDefaults(true),
  };
}

function createUser({ username, passwordHash, name }) {
  const id = store.nextUserId++;
  const user = {
    id,
    username: username.trim(),
    passwordHash,
    data: defaultData(name || username),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  save();
  return user;
}

function findUserByUsername(username) {
  return store.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
}

function findUserById(id) {
  return store.users.find(u => u.id === Number(id));
}

function getAllUsers() {
  return store.users;
}

function updateUser(user) {
  save();
  return user;
}

function nextId(user, kind) {
  const n = user.data._nextIds[kind] || 1;
  user.data._nextIds[kind] = n + 1;
  return n;
}


function getFullState(userId) {
  const user = findUserById(userId);
  if (!user) return null;
  const d = user.data;

  return {
    name: d.name,
    username: user.username,
    links: d.links || {},
    
    timeline: d.timeline
      .map(t => ({
        ...t,
        when: MONTHS[Number(String(t.date).slice(5, 7)) - 1] || t.when || '',
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
    files: d.files.map(f => ({
      id: f.id,
      name: f.name,
      expires: f.expires,
      img: f.filename ? '/uploads/' + f.filename : null,
    })),
    nsfasStep: d.nsfasStep,
    money: { ...d.money },
    payoutLog: { ...(d.payoutLog || {}) },
    tasks: d.tasks.map(t => ({ ...t })),
    modules: JSON.parse(JSON.stringify(d.modules || [])),
    timetable: d.timetable.map(c => ({ ...c })),
    fundingMode: d.fundingMode || null,
    nsfasProgress: { ...d.nsfasProgress },
    bursary: { ...d.bursary },
    selfFunded: JSON.parse(JSON.stringify(d.selfFunded)),
    wallet: { ...d.wallet },
    whatsapp: { phone: '', enabled: false, wellness: true, ...(d.whatsapp || {}) },
  };
}

module.exports = {
  init,
  createUser,
  findUserByUsername,
  findUserById,
  getAllUsers,
  updateUser,
  nextId,
  classesOn,
  getFullState,
  save,
};