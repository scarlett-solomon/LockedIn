'use strict';

const db = require('./db');
const insights = require('./insights');

const TZ = 'Africa/Johannesburg';
const SID = process.env.TWILIO_SID;
const TOKEN = process.env.TWILIO_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // sandbox number


function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '27' + d.slice(1);
  return d;
}

async function sendWhatsApp(phoneDigits, body) {
  if (!phoneDigits) return false;
  if (!SID || !TOKEN) {
    console.log(`[WhatsApp DRY RUN] -> +${phoneDigits}\n${body}\n`);
    return true;
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: FROM, To: `whatsapp:+${phoneDigits}`, Body: body }),
    });
    if (!res.ok) {
      console.error('Twilio error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('WhatsApp send failed:', e.message);
    return false;
  }
}

// SA time helpers
function saNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour}:${parts.minute}`,
    minutes: Number(hour) * 60 + Number(parts.minute),
  };
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const toMinutes = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

function ensureWA(user) {
  const d = user.data;
  if (!d.whatsapp) d.whatsapp = { phone: '', enabled: false, wellness: true };
  if (!d.sent) d.sent = {};
  return d.whatsapp;
}

// Msg builders
function tasksOn(user, date) { return user.data.tasks.filter(t => !t.done && t.due === date); }
const big = t => Number(t.weight) >= 30; 

function morningDigest(user, today) {
  const d = user.data;
  const lines = [`☀️ Good morning ${d.name}!`];
  const classes = db.classesOn(user, today);
  if (classes.length) {
    lines.push('', '📚 Today:');
    classes.forEach(c => lines.push(`• ${c.time} ${c.title}${c.room ? ' (' + c.room + ')' : ''}`));
  }
  const dueToday = tasksOn(user, today);
  const dueTomorrow = tasksOn(user, addDays(today, 1));
  if (dueToday.length) { lines.push('', '⏰ Due today:'); dueToday.forEach(t => lines.push(`• ${t.title} (${t.weight}%)`)); }
  if (dueTomorrow.length) { lines.push('', '📅 Due tomorrow:'); dueTomorrow.forEach(t => lines.push(`• ${t.title} (${t.weight}%)`)); }
  const overdue = d.tasks.filter(t => !t.done && t.due < today);
  if (overdue.length) { lines.push('', '⚠️ Overdue:'); overdue.forEach(t => lines.push(`• ${t.title}`)); }
  const expiring = d.files.filter(f => f.expires && f.expires >= today && f.expires <= addDays(today, 7));
  if (expiring.length) { lines.push('', '📄 Documents expiring this week:'); expiring.forEach(f => lines.push(`• ${f.name} (${f.expires})`)); }
  if (lines.length === 1) lines.push('Nothing urgent today. Enjoy it bestie!!');
  const ins = insights.compute(user, today);
  lines.push('', `🧠 This week: ${ins.level} workload. ${ins.headline}`);
  lines.push('', 'Reply "tasks", "today", "plan" or "relax" anytime.');
  return lines.join('\n');
}

const GOOD_LUCK = [
  "You've prepared more than you think. Trust it. You've got this 💪",
  'One question at a time. Breathe, read carefully, and do your best 🌟',
  "Your worth is not a mark. Go show what you know 🙌",
];
const WIND_DOWN = [
  "Tomorrow is a big one. Pack your bag, drink some water and get an early night. Sleep helps more than last-minute cramming 😴",
  'You\'ve done the work. Put the books down, take a walk or play a song you love, then rest 🌙',
];
const BREAKS = [
  '🌿 Quick break: stand up, stretch, drink water, and look out a window for 2 minutes.',
  '🧘 Try box breathing: in 4, hold 4, out 4, hold 4. Repeat 4 times.',
];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];


async function sendOnce(user, key, text) {
  const wa = ensureWA(user);
  if (user.data.sent[key]) return;
  user.data.sent[key] = 1;           
  db.updateUser(user);
  await sendWhatsApp(wa.phone, text);
}

function pruneSent(user, today) {
  const cutoff = addDays(today, -3);
  for (const k of Object.keys(user.data.sent || {})) {
    const date = k.slice(0, 10);
    if (date < cutoff) delete user.data.sent[k];
  }
}

// Money Hub alerts
const money$ = v => 'R' + Math.round(v).toLocaleString('en-ZA');

function appealLetter(user) {
  const rows = insights.moneyInsights(user, insights.todayISO()).payoutRows;
  const missing = rows.filter(r => r.status === 'missing' || r.status === 'late').map(r => r.label);
  const months = missing.length ? missing.join(', ') : '[Month]';
  return `📝 Copy this, fill in the [brackets] and send it to your funder:\n\n` +
    `Subject: Missing allowance payment – [Student number]\n\n` +
    `Dear NSFAS / Funding Office,\n\nI am [Full name], student number [Student number]. ` +
    `I have not received my allowance for: ${months}.\n\n` +
    `Please confirm the payment status and expected payment date.\n\nKind regards,\n[Full name]`;
}

function marksSummary(user) {
  const ac = insights.academicsInsights(user);
  if (!ac.count) return 'Add your modules in LockedIn → Academics and I can track your marks.';
  const icon = { ok: '✅', watch: '👀', risk: '⚠️', unknown: '➖' };
  const lines = ['📊 Your marks:'];
  for (const m of ac.modules) lines.push(`${icon[m.status]} ${m.name}: ${m.current == null ? 'no marks yet' : m.current + '%'}`);
  if (ac.average != null) lines.push('', `Average across your modules: ${ac.average}%.`);
  if (ac.focus) lines.push('', `Needs the most work: ${ac.focus.name}. ${ac.focus.passNote}`);
  else if (ac.marked) lines.push('', 'No module needs urgent attention right now. Keep it up 💪');
  return lines.join('\n');
}

function moneySummary(user, today) {
  const m = insights.moneyInsights(user, today);
  if (!m.mode) return 'Open LockedIn → Money Hub and pick how you are funded (NSFAS, bursary or self-funded), then I can track your money.';
  const lines = ['💰 Your money:'];
  if (m.health) lines.push(`${m.health.headline}.`, m.health.detail);
  const f = m.forecast, p = m.payout;
  if (f.ready) {
    lines.push('');
    if (p.late) lines.push(`⚠️ Your ${p.label} is ${p.daysLate} days late. Your cash lasts about ${f.daysCash} days. Reply "appeal" for a letter.`);
    else if (f.status === 'short') lines.push(`⚠️ You may run out ${p.daysAway - f.daysCash} day(s) before your ${p.label}, about ${money$(f.shortfall)} short.` +
      (f.perDayLimit != null ? ` Try to keep to ${money$(f.perDayLimit)} a day.` : ''));
    else lines.push(`✅ Your money should last until your ${p.label} (${p.date}). You have about ${f.daysCash} days of cash.`);
  } else {
    lines.push('', 'Add your balance and weekly spending in the Money Hub and I will forecast how long it lasts.');
  }
  return lines.join('\n');
}

async function moneyAlerts(user, now) {
  if (now.hhmm < '08:00' || now.hhmm >= '10:00') return;
  const m = insights.moneyInsights(user, now.date);
  if (!m.mode) return;
  const p = m.payout, f = m.forecast;

  if (!p.late && p.daysAway === 0) {
    await sendOnce(user, `${now.date}|payday`,
      `💰 Today is your expected ${p.label} day. Check your account, then tick it off in LockedIn. Reply "money" to see how long it will last.`);
  }
  if (p.late) {
    await sendOnce(user, `${now.date}|latepay`,
      `⚠️ Your ${p.label} looks ${p.daysLate} days late. Reply "appeal" and I will send you a letter you can use to follow it up.`);
  }
  if (m.mode === 'self') {
    const s = user.data.selfFunded;
    for (const i of (s.instalments || [])) {
      if (i.paid) continue;
      const left = insights.diffDays(now.date, i.due);
      if (left < 0) {
        await sendOnce(user, `${now.date}|overdue${i.id}`, `🚨 ${i.label} (${money$(i.amount)}) was due ${-left} day(s) ago. Pay it or ask for a payment plan so you do not get a fee hold.`);
      } else if (left <= 3) {
        await sendOnce(user, `${now.date}|inst${i.id}`, `🎓 ${i.label} (${money$(i.amount)}) is due ${left === 0 ? 'today' : left === 1 ? 'tomorrow' : 'in ' + left + ' days'}. Pay on time to avoid a fee hold.`);
      }
    }
  }
  if (f.ready && !p.late && f.status === 'short') {
    await sendOnce(user, `${now.date}|lowcash`,
      `💸 Heads up: at your current spending your money may run out ${p.daysAway - f.daysCash} day(s) before your ${p.label}.` +
      (f.perDayLimit != null ? ` Keep to about ${money$(f.perDayLimit)} a day to make it.` : '') + ' Reply "money" for details.');
  }
}

async function tick() {
  const now = saNow();
  for (const user of db.getAllUsers()) {
    const wa = ensureWA(user);
    if (!wa.enabled || !wa.phone) continue;
    pruneSent(user, now.date);

    // 07:00 morning reminders
    if (now.hhmm >= '07:00' && now.hhmm < '09:00') {
      await sendOnce(user, `${now.date}|digest`, morningDigest(user, now.date));
    }

    // 30 minutes before each class
    for (const c of db.classesOn(user, now.date)) {
      const diff = toMinutes(c.time) - now.minutes;
      if (diff > 0 && diff <= 30) {
        await sendOnce(user, `${now.date}|class${c.id}`, `📚 ${c.title} starts at ${c.time}${c.room ? ' in ' + c.room : ''}. Time to head out!`);
      }
    }

    // 18:00 msgfor tomorrow's tasks
    if (now.hhmm >= '18:00' && now.hhmm < '20:00') {
      const tomorrow = tasksOn(user, addDays(now.date, 1));
      if (tomorrow.length) {
        await sendOnce(user, `${now.date}|evening`,
          `⏰ Reminder: due tomorrow:\n` + tomorrow.map(t => `• ${t.title} (${t.weight}%)`).join('\n'));
      }
    }

    // Early warning
    if (now.hhmm >= '16:00' && now.hhmm < '18:00') {
      const ins = insights.compute(user, now.date);
      for (const t of user.data.tasks) {
        if (t.done || (Number(t.weight) || 0) < 20) continue;
        const left = insights.diffDays(now.date, t.due);
        if (left >= 1 && left <= ins.habit.leadDays) {
          const nudge = ins.habit.label === 'last-minute'
            ? 'You usually finish close to the deadline, so starting today will make the week calmer.'
            : 'A short session today keeps you ahead.';
          await sendOnce(user, `${now.date}|early${t.id}`,
            `⏳ ${t.title} (${t.weight}%) is due in ${left} day${left === 1 ? '' : 's'}. ${nudge}`);
        }
      }
    }

    // Sunday evening msg
    if (new Date(now.date + 'T00:00:00Z').getUTCDay() === 0 && now.hhmm >= '17:00' && now.hhmm < '20:00') {
      const planKey = `${now.date}|plan`;
      if (!user.data.sent[planKey]) {
        user.data.sent[planKey] = 1;          
        db.updateUser(user);
        const { plan } = await insights.weeklyPlan(user);
        await sendWhatsApp(wa.phone, plan);
      }
    }

    // Money alerts
    await moneyAlerts(user, now);

    // Wellness (only if the student has it switched on)
    if (wa.wellness) {
      const bigToday = tasksOn(user, now.date).filter(big);
      const bigTomorrow = tasksOn(user, addDays(now.date, 1)).filter(big);
      if (bigToday.length && now.hhmm >= '07:30' && now.hhmm < '10:00') {
        await sendOnce(user, `${now.date}|luck`, `🍀 ${bigToday[0].title} is today. ${pick(GOOD_LUCK)}`);
      }
      if (bigTomorrow.length && now.hhmm >= '20:00' && now.hhmm < '22:00') {
        await sendOnce(user, `${now.date}|winddown`, `🌙 ${pick(WIND_DOWN)}`);
      }
      // Study break msg
      const heavy = user.data.tasks.filter(t => !t.done && big(t) && t.due >= now.date && t.due <= addDays(now.date, 3));
      if (heavy.length >= 2 && now.hhmm >= '15:00' && now.hhmm < '17:00') {
        await sendOnce(user, `${now.date}|break`, pick(BREAKS));
      }
    }
  }
}

function startScheduler() {
  console.log(`  WhatsApp assistant: ${SID ? 'Twilio connected' : 'DRY RUN (no Twilio keys, messages print to console)'}`);
  setInterval(() => tick().catch(e => console.error('Scheduler error:', e)), 60 * 1000);
}

// More msgs
function findUserByPhone(digits) {
  return db.getAllUsers().find(u => {
    const wa = u.data.whatsapp;
    return wa && wa.phone && wa.phone === digits;
  });
}

function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function handleIncoming(fromRaw, bodyRaw) {
  const user = findUserByPhone(normalizePhone(String(fromRaw).replace('whatsapp:', '')));
  const text = String(bodyRaw || '').trim().toLowerCase();

  if (!user) {
    return 'Hi! I\'m the LockedIn assistant. Open LockedIn → your profile → add this WhatsApp number to link your account.';
  }
  const wa = ensureWA(user);
  const now = saNow();

  if (text === 'stop') { wa.enabled = false; db.updateUser(user); return 'Okay, reminders are off. Reply "start" to turn them back on.'; }
  if (text === 'start') { wa.enabled = true; db.updateUser(user); return 'Reminders are back on ✅'; }

  if (text.includes('relax') || text.includes('stress') || text.includes('anxious') || text.includes('overwhelm')) {
    return 'Let\'s pause for a moment 🌿\nBreathe in for 4, hold for 4, out for 4. Repeat 4 times.\nThen drink some water and do just ONE small thing next. You\'re doing better than you think 💛';
  }
  if (text === 'received') {
    const key = now.date.slice(0, 7);
    if (!user.data.payoutLog) user.data.payoutLog = {};
    user.data.payoutLog[key] = 'received'; db.updateUser(user);
    return '✅ Marked this month\'s payout as received. Reply "money" to see how long it will last.';
  }
  if (text === 'marks' || text === 'grades' || text === 'average' || text.includes('my marks')) return marksSummary(user);
  if (text.includes('appeal') || text.includes('missing payout')) return appealLetter(user);
  if (text.includes('money') || text.includes('payout') || text.includes('budget') || text.includes('fees')) return moneySummary(user, now.date);
  if (text === 'plan' || text.includes('my plan') || text.includes('study plan')) {
    return insights.weeklyPlan(user).then(r => r.plan);   // async: the webhook waits for it
  }
  if (text.includes('forecast') || text.includes('risk') || text.includes('workload')) {
    const ins = insights.compute(user, now.date);
    return `🧠 Workload this week: ${ins.level} (${ins.weekLoad}% due).\n${ins.headline}\n\nReply "plan" for a personal plan.`;
  }
  if (text.includes('today') || text.includes('class')) return morningDigest(user, now.date);

  if (text.includes('task') || text.includes('due') || text.includes('week')) {
    const list = user.data.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due));
    if (!list.length) return 'You have no open tasks 🎉';
    return '📝 Your tasks:\n' + list.map(t => `• ${t.title}: due ${t.due} (${t.weight}%)`).join('\n') +
      '\n\nReply "done <task name>" to tick one off.';
  }

  if (text.startsWith('done')) {
    const q = text.replace(/^done\s*/, '');
    const t = user.data.tasks.find(x => !x.done && q && x.title.toLowerCase().includes(q));
    if (!t) return 'I couldn\'t find that task. Reply "tasks" to see your list.';
    t.done = true; t.completedAt = now.date; db.updateUser(user);
    return `✅ Ticked off "${t.title}". Nice work!`;
  }

  return 'I can help with:\n• "today": classes & what\'s due\n• "tasks": all open tasks\n• "plan": your personal plan for the week\n• "forecast": how heavy your week is\n• "marks": your current marks and which module needs work\n• "money": your funding health and how long your money lasts\n• "received": mark this month\'s payout as received\n• "appeal": a letter for a missing payout\n• "done <task>": tick one off\n• "relax": a quick calm-down\n• "stop" / "start": reminders';
}

module.exports = { sendWhatsApp, startScheduler, handleIncoming, normalizePhone, xml, ensureWA };