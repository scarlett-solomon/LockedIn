'use strict';

const db = require('./db');

const TZ = 'Africa/Johannesburg';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const lastPlans = new Map(); 

// SA time helpers
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function dayName(iso) { return DAYS[new Date(iso + 'T00:00:00Z').getUTCDay()]; }

// Money Hub
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = n => String(n).padStart(2, '0');
const n0 = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const sum = (arr, k) => (arr || []).reduce((s, x) => s + (Number(x[k]) || 0), 0);
const rand = v => 'R' + Math.round(v).toLocaleString('en-ZA');


function examNeeded(target, avg, weightPct) {
  const w = weightPct / 100;
  return Number(((target - avg * (1 - w)) / w).toFixed(6));
}

// Marks
const PASS = 50, DISTINCTION = 75;
const r1 = v => Math.round(v * 10) / 10;
const pct = v => `${r1(v)}%`;


function moduleStats(m) {
  const list = m.assessments || [];
  const w = x => Number(x.weight) || 0;
  const marked = list.filter(x => x.mark != null && x.mark !== '' && !isNaN(Number(x.mark)));
  const unmarked = list.filter(x => !marked.includes(x));
  const total = list.reduce((s, x) => s + w(x), 0);
  const markedWeight = marked.reduce((s, x) => s + w(x), 0);
  const earned = marked.reduce((s, x) => s + Number(x.mark) * w(x) / 100, 0);
  const remaining = Math.max(0, 100 - markedWeight);
  const current = markedWeight > 0 ? earned / markedWeight * 100 : null;
  const weightsOk = Math.abs(total - 100) < 0.01;
  const finished = list.length > 0 && remaining < 0.0001;
  const need = t => (finished ? null : Number(((t - earned) / remaining * 100).toFixed(6)));
  const needPass = need(PASS), needDist = need(DISTINCTION);
  const where = unmarked.length === 1 && weightsOk ? `on your ${unmarked[0].name}` : `on the remaining ${r1(remaining)}%`;

  let status, passNote, distNote;
  if (!list.length) {
    status = 'unknown'; passNote = 'Add your tests, assignments and exam to start tracking this module.'; distNote = '';
  } else if (current == null) {
    status = 'unknown'; passNote = 'Enter your first mark and I will work out what you need.'; distNote = '';
  } else if (finished) {
    status = current >= PASS ? 'ok' : 'risk';
    passNote = current >= PASS ? `Finished on ${pct(current)}. You passed.` : `Finished on ${pct(current)}, below the ${PASS}% pass mark.`;
    distNote = current >= DISTINCTION ? 'Distinction.' : '';
  } else {
    if (needPass <= 0) { status = 'ok'; passNote = `Pass secured, whatever you get ${where}.`; }
    else if (needPass > 100) { status = 'risk'; passNote = `Even full marks ${where} would not reach ${PASS}%.`; }
    else {
      status = current < PASS ? 'risk' : current < 60 ? 'watch' : 'ok';
      passNote = `To pass you need ${Math.ceil(needPass)}% ${where}.`;
    }
    distNote = needDist <= 0 ? 'Distinction secured.'
      : needDist > 100 ? `A distinction (${DISTINCTION}%) is out of reach this semester.`
      : `For a distinction (${DISTINCTION}%) you need ${Math.ceil(needDist)}% ${where}.`;
  }
  return {
    id: m.id, name: m.name, status, finished, passNote, distNote,
    current: current == null ? null : r1(current),
    markedWeight: r1(markedWeight), remaining: r1(remaining), total: r1(total), weightsOk,
    needPass: needPass == null ? null : Math.max(0, Math.ceil(needPass)),
    needDistinction: needDist == null ? null : Math.max(0, Math.ceil(needDist)),
    impossible: !finished && current != null && needPass > 100,
    warning: list.length && total < 99.99 ? `Your weights add up to ${r1(total)}%. Check your module guide so the maths is right.` : '',
    unmarked: unmarked.map(x => x.name),
  };
}

function academicsInsights(user) {
  const modules = ((user.data && user.data.modules) || []).map(moduleStats);
  const marked = modules.filter(m => m.current != null);
  const byMark = [...marked].sort((a, b) => a.current - b.current);
  const attention = byMark.filter(m => m.status === 'risk' || m.status === 'watch');
  return {
    modules, count: modules.length, marked: marked.length,
    average: marked.length ? r1(marked.reduce((s, m) => s + m.current, 0) / marked.length) : null,
    focus: attention[0] || null,
    weakest: byMark[0] || null,
    strongest: byMark.length > 1 ? byMark[byMark.length - 1] : null,
  };
}

const monthKeyOf = (today, offset) => {
  let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1 + offset;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return `${y}-${pad2(m + 1)}`;
};
const payDateOf = (d, key) => `${key}-${pad2(Math.min(28, Math.max(1, Number(d.wallet && d.wallet.payoutDay) || 25)))}`;

function payoutState(d, today, key) {
  const date = payDateOf(d, key);
  const logged = (d.payoutLog || {})[key];
  const daysLate = Math.max(0, diffDays(date, today));
  if (logged === 'received' || logged === 'missing') return { status: logged, date, daysLate };
  if (daysLate <= 1) return { status: 'expected', date, daysLate };
  return { status: key === today.slice(0, 7) ? 'late' : 'unconfirmed', date, daysLate };
}


function payoutRows(d, today) {
  const m = d.money || {};
  const parts = [n0(m.accommodation), n0(m.food)].filter(v => v != null);
  const amount = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  return [0, -1, -2, -3].map(off => {
    const key = monthKeyOf(today, off);
    const y = key.slice(0, 4), mi = Number(key.slice(5, 7)) - 1;
    return { key, label: `${MONTH_NAMES[mi]} ${y}`, month: MONTH_NAMES[mi], amount, ...payoutState(d, today, key) };
  });
}


function nextPayout(d, today) {
  const mode = d.fundingMode;
  const label = mode === 'self' ? 'income' : 'payout';
  const cur = today.slice(0, 7);
  const nextMonth = () => {
    const date = payDateOf(d, monthKeyOf(today, 1));
    return { date, daysAway: diffDays(today, date), late: false, daysLate: 0, label };
  };
  if (mode === 'self') {
    const date = payDateOf(d, cur);
    return today <= date ? { date, daysAway: diffDays(today, date), late: false, daysLate: 0, label } : nextMonth();
  }
  const st = payoutState(d, today, cur);
  if (st.status === 'received') return nextMonth();
  if (st.status === 'missing' || st.status === 'late') {
    return { date: st.date, daysAway: 0, late: true, daysLate: Math.max(1, st.daysLate), label };
  }
  return { date: st.date, daysAway: Math.max(0, diffDays(today, st.date)), late: false, daysLate: 0, label };
}

function cashForecast(d, today, np) {
  const w = d.wallet || {};
  const balance = n0(w.balance), weekly = n0(w.weeklySpend);
  if (balance == null || weekly == null || weekly <= 0) return { ready: false };
  const perDay = weekly / 7;
  const daysCash = Math.floor(balance / perDay);
  const f = {
    ready: true, balance, weeklySpend: weekly, daysCash,
    daysToPayout: np.daysAway, payoutDate: np.date, late: np.late,
    runOutDate: addDays(today, daysCash), shortfall: 0, perDayLimit: null,
  };
  if (np.late) {
  
    f.status = daysCash >= 14 ? 'ok' : daysCash >= 7 ? 'tight' : 'short';
    return f;
  }
  const gap = daysCash - np.daysAway;
  f.status = gap >= 3 ? 'ok' : gap >= 0 ? 'tight' : 'short';
  if (f.status === 'short') f.shortfall = Math.ceil((np.daysAway - daysCash) * perDay);
  if (np.daysAway > 0) f.perDayLimit = Math.floor(balance / np.daysAway);
  return f;
}

function nsfasHealth(d) {
  const p = d.nsfasProgress || {};
  const min = Number(p.minRate) || 55;
  const ac = academicsInsights({ data: d });
  const exam = ac.focus ? `${ac.focus.name}: ${ac.focus.passNote}` : null;
  if (p.enrolled == null || p.enrolled <= 0) {
    return { status: 'unknown', headline: 'Add your modules to check your funding',
      detail: `NSFAS asks you to pass a minimum share of your modules each year (${min}% here; confirm yours in your funding letter).`, exam };
  }
  const enrolled = p.enrolled, passed = p.passed || 0, failed = p.failed || 0;
  const needPass = Math.ceil(min / 100 * enrolled - 1e-9);
  const stillNeed = Math.max(0, needPass - passed);
  const remaining = enrolled - passed - failed;
  const base = { min, enrolled, passed, failed, needPass, stillNeed, remaining, exam };
  if (stillNeed === 0) return { ...base, status: 'ok', headline: "You're on track to keep your funding", detail: `You have passed ${passed} of ${enrolled} modules, which already meets the ${min}% requirement.` };
  if (stillNeed > remaining) return { ...base, status: 'risk', headline: 'Your funding is at risk',
    detail: `You need ${needPass} of ${enrolled} modules for ${min}%, but only ${passed + remaining} are still possible. Talk to your funding office and prepare an appeal.` };
  if (remaining - stillNeed <= 1) return { ...base, status: 'watch', headline: `Pass ${stillNeed} of your ${remaining} remaining modules`,
    detail: `You have passed ${passed} of ${enrolled}. ${remaining - stillNeed === 0 ? 'There is no room for a fail.' : 'You can afford one fail at most.'}` };
  return { ...base, status: 'ok', headline: "You're on track, keep going",
    detail: `You have passed ${passed} of ${enrolled}. Pass ${stillNeed} more of the ${remaining} remaining to reach ${min}%.` };
}

function bursaryHealth(d) {
  const b = d.bursary || {};
  const min = n0(b.minAvg);
  const avg = n0(b.currentAvg) != null ? n0(b.currentAvg) : n0(academicsInsights({ data: d }).average);
  const sponsor = b.sponsor || 'your sponsor';
  const modulesLeft = n0(b.minModules) != null ? Math.max(0, b.minModules - (b.modulesPassed || 0)) : null;
  const ac = academicsInsights({ data: d });
  const exam = min != null && avg != null && avg - min < 5 && ac.weakest && ac.marked > 1
    ? `${ac.weakest.name} is your lowest module on ${ac.weakest.current}%. ${ac.weakest.passNote}` : null;
  const base = { min, avg, modulesLeft, exam, sponsor };
  if (min == null) return { ...base, status: 'unknown', headline: 'Add your bursary condition to check it',
    detail: 'Enter the minimum average your sponsor asks for, and I will compare it with your marks.' };
  if (avg == null) return { ...base, status: 'unknown', headline: `Your sponsor needs ${min}% average`, detail: 'Enter your current average to see where you stand.' };
  const gap = Math.round((avg - min) * 10) / 10;
  const mods = modulesLeft ? ` You also still need to pass ${modulesLeft} more module${modulesLeft === 1 ? '' : 's'}.` : '';
  if (gap < 0) return { ...base, gap, status: 'risk', headline: `You need ${min}% average, you're on ${avg}%`,
    detail: `You are ${Math.abs(gap)} points below what ${sponsor} asks for. Speak to them early, before results are due.${mods}` };
  if (gap < 5) return { ...base, gap, status: 'watch', headline: `You need ${min}% average, you're on ${avg}%`,
    detail: `Only ${gap} points of room. One bad result could cost you the bursary.${mods}` };
  return { ...base, gap, status: 'ok', headline: `You need ${min}% average, you're on ${avg}%`,
    detail: `You are ${gap} points above the condition, so you are on track to keep your bursary.${mods}` };
}

function selfHealth(d, today) {
  const s = d.selfFunded || {};
  const total = n0(s.feesTotal);
  const owing = total == null ? null : Math.max(0, total - (n0(s.feesPaid) || 0));
  const unpaid = (s.instalments || []).filter(i => !i.paid).sort((a, b) => a.due.localeCompare(b.due));
  const overdue = unpaid.filter(i => i.due < today);
  const next = unpaid.find(i => i.due >= today) || null;
  const incomeTotal = sum(s.income, 'amount'), budgetTotal = sum(s.budget, 'amount');
  const surplus = incomeTotal - budgetTotal;
  const base = { owing, next, overdue, incomeTotal, budgetTotal, surplus };
  if (overdue.length) {
    const n = diffDays(overdue[0].due, today);
    return { ...base, status: 'risk', headline: `${overdue[0].label} is ${n} day${n === 1 ? '' : 's'} overdue`,
      detail: 'Late fees can put a hold on your account. Pay now, or ask the finance office for an arrangement.' };
  }
  if (next && diffDays(today, next.due) <= 7) {
    const n = diffDays(today, next.due);
    return { ...base, status: 'watch', headline: `${next.label} of ${rand(next.amount)} is due ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'}`,
      detail: 'Pay on time to avoid a fee hold.' };
  }
  if (total == null && !unpaid.length) return { ...base, status: 'unknown', headline: 'Add your fees to track them', detail: 'Enter your total fees and what you have paid.' };
  if (incomeTotal > 0 && budgetTotal > 0 && surplus < 0) return { ...base, status: 'watch', headline: `You spend ${rand(-surplus)} more than you earn each month`, detail: 'Trim a category in your budget, or find extra income.' };
  return { ...base, status: 'ok', headline: owing === 0 ? 'Your fees are paid up' : owing != null ? `${rand(owing)} still owing, nothing due soon` : 'Nothing due soon',
    detail: next ? `Next instalment: ${next.label}, ${next.due}.` : 'No upcoming instalments.' };
}

// Smart bits
const ordinal = n => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;


function payoutPattern(d, today) {
  if (d.fundingMode === 'self') return null;
  const log = d.payoutLog || {}, dates = d.payoutDates || {};
  const keys = Object.keys(log).sort().slice(-6);
  const days = keys.filter(k => log[k] === 'received' && dates[k]).map(k => Number(dates[k].slice(8, 10))).slice(-4).sort((a, b) => a - b);
  const missing = keys.filter(k => log[k] === 'missing').length;
  const logged = keys.filter(k => log[k] === 'received' || log[k] === 'missing').length;
  const usual = Math.min(28, Math.max(1, Number(d.wallet && d.wallet.payoutDay) || 25));
  if (days.length < 2) {
    return { learned: false, missing, logged, usual,
      text: 'Tap a payout "Received" on the day it lands and I will learn when yours usually arrives.' };
  }
  const mid = days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2;
  const typical = Math.min(28, Math.round(mid));
  const offset = typical - usual;
  const when = offset === 0 ? `on time, around the ${ordinal(typical)}`
    : `around the ${ordinal(typical)}, ${plural(Math.abs(offset), 'day')} ${offset > 0 ? 'after' : 'before'} your usual ${ordinal(usual)}`;
  let text = `Your last ${days.length} payouts landed ${when}. I expect this month's about the ${ordinal(typical)}.`;
  if (missing > 0) text += ` ${missing} of your last ${logged} logged payouts went missing, so chase it if it is not in by then.`;
  return { learned: true, samples: days.length, typicalDay: typical, usual, offset, missing, logged,
    expectedDate: `${today.slice(0, 7)}-${pad2(typical)}`, text };
}

// Mark calcs
function marksWarning(d, today) {
  const soon = d.tasks.filter(t => !t.done && t.due >= today && t.due <= addDays(today, 14) && Number(t.weight) >= 20)
    .sort((a, b) => a.due.localeCompare(b.due));
  if (!soon.length) return null;
  const b = d.bursary || {};
  const ac = academicsInsights({ data: d });
  let task, target, avg, goal;
  if (d.fundingMode === 'bursary' && n0(b.minAvg) != null && (n0(b.currentAvg) != null || ac.average != null)) {
    task = soon[0]; target = n0(b.minAvg); avg = n0(b.currentAvg) != null ? n0(b.currentAvg) : ac.average;
    goal = `hold your ${target}% bursary average`;
  } else {
   
    let mod;
    task = soon.find(t => (mod = ac.modules.find(m => m.current != null && !m.finished && t.title.toLowerCase().includes(m.name.toLowerCase()))));
    if (!task) return null;
    target = 50; avg = mod.current; goal = `stay on track to pass ${mod.name}`;
  }
  const need = examNeeded(target, avg, Number(task.weight));
  const when = diffDays(today, task.due) === 0 ? 'today' : diffDays(today, task.due) === 1 ? 'tomorrow' : dayName(task.due);
  if (need < 40) return null;   // a comfortable target is not worth a warning
  if (need > 100) return `${task.title} (${task.weight}%, ${when}): even full marks will not be enough to ${goal}. Speak to your sponsor or lecturer early.`;
  return `${task.title} (${task.weight}%, ${when}): aim for at least ${Math.ceil(need)}% to ${goal}.`;
}


function noticed(d, today, parts) {
  const out = [];
  const { health, forecast, pattern, habit } = parts;
  const marks = marksWarning(d, today);
  if (marks) out.push({ kind: 'Marks', text: marks });
  if (health && (health.status === 'risk' || health.status === 'watch')) out.push({ kind: 'Funding', text: `${health.headline}. ${health.detail}` });
  if (forecast && forecast.ready) {
    let text;
    if (forecast.late) text = `Your payout is late, and your cash covers about ${plural(forecast.daysCash, 'day')}.`;
    else if (forecast.status === 'short') text = `Your cash covers ${plural(forecast.daysCash, 'day')} but money lands in ${plural(forecast.daysToPayout, 'day')}.${forecast.perDayLimit != null ? ` Stay under ${rand(forecast.perDayLimit)} a day to make it.` : ''}`;
    else if (forecast.status === 'tight') text = 'Your money only just lasts until payday. Keep spending steady.';
    else text = `Your money lasts until payday with ${plural(forecast.daysCash - forecast.daysToPayout, 'day')} to spare.`;
    out.push({ kind: 'Money', text });
  }
  if (pattern) out.push({ kind: 'Payout', text: pattern.text });
  if (habit.label === 'unknown') {
    out.push({ kind: 'Habit', text: 'Tick off a few tasks and I will learn when you usually get work done.' });
  } else {
    const way = habit.label === 'last-minute' ? 'close to the deadline' : habit.label === 'early' ? 'well before the deadline' : 'a day or two before the deadline';
    out.push({ kind: 'Habit', text: `You usually finish ${way} (learned from your last ${habit.samples} tasks), so I warn you ${plural(habit.leadDays, 'day')} ahead.` });
  }
  return out.slice(0, 5);
}

function moneyInsights(user, today) {
  const d = user.data;
  const mode = d.fundingMode || null;
  const np = nextPayout(d, today);
  const health = mode === 'nsfas' ? nsfasHealth(d) : mode === 'bursary' ? bursaryHealth(d) : mode === 'self' ? selfHealth(d, today) : null;
  return { mode, health, payout: np, payoutRows: payoutRows(d, today), forecast: cashForecast(d, today, np), pattern: payoutPattern(d, today) };
}

// Forecast
function compute(user, today = todayISO()) {
  const d = user.data;
  const open = d.tasks.filter(t => !t.done);

  const days = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    const items = open.filter(t => t.due === date);
    days.push({
      date,
      day: dayName(date),
      load: items.reduce((s, t) => s + (Number(t.weight) || 0), 0),
      items: items.map(t => t.title),
    });
  }
  const week = days.slice(0, 7);
  const weekLoad = week.reduce((s, x) => s + x.load, 0);
  const peak = week.reduce((a, b) => (b.load > a.load ? b : a), week[0]);
  const overdue = open.filter(t => t.due < today);
  const bigSoon = open.filter(t => Number(t.weight) >= 30 && t.due >= today && t.due <= addDays(today, 3)).length;

  const score = weekLoad + overdue.length * 15 + (bigSoon >= 2 ? 20 : 0);
  const level = score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low';

  const finished = d.tasks
    .filter(t => t.done && t.completedAt && t.due)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    .slice(-8);
  let habit = { label: 'unknown', avgMarginDays: null, samples: finished.length, leadDays: 2 };
  if (finished.length >= 2) {
    const margins = finished.map(t => diffDays(t.completedAt, t.due)); 
    const avg = margins.reduce((s, m) => s + m, 0) / margins.length;
    const label = avg <= 0.5 ? 'last-minute' : avg >= 2 ? 'early' : 'steady';
    habit = {
      label,
      avgMarginDays: Math.round(avg * 10) / 10,
      samples: finished.length,
      leadDays: label === 'last-minute' ? 3 : label === 'early' ? 1 : 2, 
    };
  }

  const academics = academicsInsights(user);
  const f = academics.focus;
  const exam = f && f.needPass != null ? { course: f.name, avg: f.current, needPass: f.needPass, needDistinction: f.needDistinction } : null;

  const upcoming = open
    .filter(t => t.due >= today && t.due <= addDays(today, 14))
    .sort((a, b) => a.due.localeCompare(b.due) || (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .map(t => ({ title: t.title, due: t.due, day: dayName(t.due), weight: Number(t.weight) || 0, daysLeft: diffDays(today, t.due) }));


  let headline;
  if (overdue.length) {
    headline = `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}. Clear ${overdue.length === 1 ? 'it' : 'those'} first.`;
  } else if (level !== 'Low' && peak.load > 0) {
    headline = `${peak.day} is your heaviest day (${peak.load}% due). Start early.`;
  } else if (weekLoad > 0) {
    headline = 'A light week. A good time to get ahead.';
  } else {
    headline = 'Nothing due this week. Enjoy the breathing room.';
  }

  const money = moneyInsights(user, today);

  return {
    today,
    level,
    score,
    weekLoad,
    days,
    peak: { day: peak.day, date: peak.date, load: peak.load },
    overdue: overdue.map(t => t.title),
    habit,
    exam,
    academics,
    upcoming,
    headline,
    money,
    noticed: noticed(d, today, { health: money.health, forecast: money.forecast, pattern: money.pattern, habit }),
    missingPayouts: payoutRows(d, today).filter(r => r.status === 'missing' || r.status === 'late').length,
  };
}

//Default msg
function rulePlan(ins) {
  const lines = [`🧠 Your week ahead: ${ins.level} workload.`, ins.headline, ''];
  const soon = ins.upcoming.filter(t => t.daysLeft <= 7).slice(0, 3);
  for (const t of soon) {
    const start = Math.max(0, t.daysLeft - ins.habit.leadDays);
    const when = start === 0 ? 'today' : dayName(addDays(ins.today, start));
    lines.push(`• ${t.title} (${t.weight}%), due ${t.day}. Start ${when}.`);
  }
  if (!soon.length) lines.push('• Nothing due in the next 7 days. Use the time to get ahead.');
  if (ins.exam && ins.exam.needPass <= 100) {
    lines.push('', `📊 ${ins.exam.course} needs the most work (${ins.exam.avg}% so far). You need ${ins.exam.needPass}% on the work still to come to pass.`);
  }
  lines.push('', ins.level === 'High'
    ? '🌿 Heavy week: plan one proper break each day and get a full night of sleep before your big days.'
    : '🌿 Keep a steady pace and take a short walk between study sessions.');
  return lines.join('\n');
}

// Smart msg
async function weeklyPlan(user) {
  const ins = compute(user);
  const fallback = () => ({ plan: rulePlan(ins), source: 'rules' });
  const key = process.env.ANTHROPIC_API_KEY;
  let result;

  if (!key) {
    result = fallback();
  } else {
    try {
      
      const data = {
        today: ins.today,
        weekday: dayName(ins.today),
        riskLevel: ins.level,
        weekLoadPercent: ins.weekLoad,
        heaviestDay: ins.peak,
        overdueTasks: ins.overdue,
        upcomingTasks: ins.upcoming.slice(0, 8),
        classes: db.classesOn(user, ins.today).map(c => `${c.time} ${c.title}`),
        workHabit: ins.habit.label,
        usuallyFinishesDaysBeforeDeadline: ins.habit.avgMarginDays,
        exam: ins.exam,
        modules: ins.academics.modules.filter(m => m.current != null).map(m => ({ module: m.name, markSoFar: m.current, status: m.status })),
      };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
          max_tokens: 400,
          system:
            'You are LockedIn, a warm and practical study coach for South African university students. ' +
            'Write ONE short WhatsApp message (max 120 words, plain text, no markdown, at most 3 emojis). ' +
            'Include: a one-line read of the week, exactly 3 concrete actions that name the day to do them, ' +
            'and one short wellbeing tip. Use only the data given. Do not invent tasks, marks or dates. ' +
            'Be encouraging, never preachy.',
          messages: [{ role: 'user', content: 'Here is the student\'s data:\n' + JSON.stringify(data) }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('Claude API ' + res.status);
      const json = await res.json();
      const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) throw new Error('empty reply');
      result = { plan: text, source: 'claude' };
    } catch (e) {
      console.error('Claude plan failed, using rules instead:', e.message);
      result = fallback();
    }
  }
  lastPlans.set(user.id, result);
  return result;
}

const getLastPlan = userId => lastPlans.get(userId) || null;

module.exports = { moneyInsights, rand, todayISO, addDays, diffDays, dayName, compute, weeklyPlan, getLastPlan, academicsInsights, moduleStats };