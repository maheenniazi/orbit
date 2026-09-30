// "Ask" chat: AI assistant grounded in your calendar + notes. Can add events. Offline fallback answers schedule questions.
import { store, addEvents, getCourse } from './store.js';
import { aiEnabled, ask } from './ai.js';
import { esc, md, todayISO, addDays, fmtDate, fmtTime, TYPE_META, EXAM_TYPES, daysUntil } from './util.js';
import { spinner, toast } from './ui.js';
import { getFocusState, syncStudyPlans } from './focus.js';

const PREFILL_KEY = 'studyos:chat-prefill';
export function askAbout(text) {
  sessionStorage.setItem(PREFILL_KEY, text);
  location.hash = '#/chat';
}

function contextBlock(question) {
  const s = store.get();
  const today = todayISO();
  const horizon = addDays(today, 45);
  const upcoming = s.events
    .filter((e) => e.date >= addDays(today, -3) && e.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 80)
    .map((e) => `- ${e.date}${e.time ? ' ' + e.time : ''} | ${TYPE_META[e.type]?.label} | ${getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || '-'} | ${e.title}${e.done ? ' (done)' : ''}${e.notes ? ' | ' + e.notes : ''}`)
    .join('\n');
  const q = question.toLowerCase();
  const mentioned = s.notes.filter((n) => n.title && q.includes(n.title.toLowerCase())).slice(0, 2);
  const noteList = s.notes.slice(0, 40).map((n) => `- ${n.title} (${getCourse(n.courseId)?.code || 'general'})`).join('\n');
  const f = getFocusState();
  return `Today is ${today} (${fmtDate(today, { weekday: 'long' })}).
Focus mode: ${f.mode.label}${f.exam ? `, next exam "${f.exam.title}" in ${f.days} day(s)` : ''}.
Courses: ${s.courses.map((c) => `${c.code || ''} ${c.name}`.trim()).join('; ') || 'none yet'}
Upcoming events:
${upcoming || '(none)'}
Notes:
${noteList || '(none)'}
${mentioned.map((n) => `\n--- Full note: ${n.title} ---\n${n.body.slice(0, 8000)}`).join('\n')}`;
}

const SYSTEM = `You are a warm, sharp study assistant inside a student's productivity app.
Answer questions about their schedule, courses and notes, explain concepts clearly, make study plans, and quiz them when asked (one question at a time, then give feedback).
Be concise and use markdown (short paragraphs, bullet lists, **bold** key terms).
If the user asks you to add/schedule something, include one line per event exactly like:
<<ADD_EVENT {"title":"...","type":"assignment|exam|midterm|final|quiz|project|reading|lab|study|class|other","date":"YYYY-MM-DD","time":"HH:MM or empty"}>>
and confirm in plain words. Never output ADD_EVENT unless asked to add something.`;

function applyActions(text) {
  const added = [];
  const cleaned = text.replace(/<<ADD_EVENT\s*(\{[\s\S]*?\})\s*>>/g, (_, json) => {
    try {
      const e = JSON.parse(json);
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.date)) added.push({ title: e.title || 'Untitled', type: TYPE_META[e.type] ? e.type : 'other', date: e.date, time: e.time || '', source: 'chat' });
    } catch { /* ignore */ }
    return '';
  });
  if (added.length) {
    addEvents(added);
    if (added.some((e) => EXAM_TYPES.includes(e.type))) syncStudyPlans();
    toast(`Added ${added.length} event${added.length > 1 ? 's' : ''} to your calendar`);
  }
  return cleaned.trim();
}

// Offline: answer the most common schedule questions from local data.
function localAnswer(q) {
  const s = store.get();
  const t = q.toLowerCase();
  const today = todayISO();
  const list = (evs) => evs.length
    ? evs.map((e) => `- **${e.title}**: ${fmtDate(e.date)}${e.time ? ' ' + fmtTime(e.time) : ''} ${getCourse(e.courseId) ? `(${getCourse(e.courseId).code || getCourse(e.courseId).name})` : ''}`).join('\n')
    : '- Nothing found';
  const sorted = [...s.events].filter((e) => !e.done).sort((a, b) => a.date.localeCompare(b.date));
  if (/exam|midterm|final|test/.test(t)) {
    const ex = sorted.filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today);
    return `Your upcoming exams:\n${list(ex)}${ex[0] ? `\n\nThe next one is **${daysUntil(ex[0].date)} days** away.` : ''}`;
  }
  let range = null;
  if (/today/.test(t)) range = [today, today, 'today'];
  else if (/tomorrow/.test(t)) range = [addDays(today, 1), addDays(today, 1), 'tomorrow'];
  else if (/next week/.test(t)) range = [addDays(today, 7), addDays(today, 13), 'next week'];
  else if (/week|due|deadline|upcoming|soon/.test(t)) range = [today, addDays(today, 6), 'in the next 7 days'];
  if (range) {
    const evs = sorted.filter((e) => e.date >= range[0] && e.date <= range[1] && e.type !== 'class');
    return `Here's what's on ${range[2]}:\n${list(evs)}`;
  }
  return `I'm in **offline mode**, so I can answer schedule questions like *“what's due this week?”* or *“when are my exams?”*.\n\nAdd \`KIRO_API_KEY\` (or an Anthropic/OpenAI key) to \`.env\` to unlock full answers, explanations, and quizzes.`;
}

export function render(el) {
  const s = store.get();
  el.innerHTML = `
    <div class="page-head view-enter">
      <div><div class="kicker">ask · ${aiEnabled() ? 'connected' : 'offline'}</div><h1>ask <em>orbit</em></h1><p>${aiEnabled() ? 'Knows your calendar, courses and notes. Ask it to explain, plan, quiz you, or add events.' : 'Offline mode: schedule questions only. Connect Kiro (or another AI key) for the full assistant.'}</p></div>
      <button class="btn ghost sm" id="clear">clear chat</button>
    </div>
    <div class="card chat view-enter">
      <div class="chat-log" id="log"></div>
      <div class="chat-input">
        <textarea id="in" rows="1" placeholder="what’s due this week? · quiz me on my notes · explain mitosis like i’m 5"></textarea>
        <button class="btn" id="send">send</button>
      </div>
    </div>`;
  const log = el.querySelector('#log');
  const input = el.querySelector('#in');

  const drawLog = () => {
    const msgs = store.get().chat;
    if (!msgs.length) {
      log.innerHTML = `<div class="empty" style="margin:auto"><span class="big">ask me anything.</span>your schedule, your notes, or that one concept you still don’t get
        <div class="suggestions">${["what's due this week?", 'when is my next exam?', 'make me a study plan for my next exam', 'add: essay draft due friday'].map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
      log.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { input.value = b.dataset.q; send(); }));
      return;
    }
    log.innerHTML = msgs.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? md(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  };

  let busy = false;
  async function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = '';
    store.update((st) => st.chat.push({ role: 'user', content: text, ts: Date.now() }));
    drawLog();
    log.insertAdjacentHTML('beforeend', `<div class="msg assistant" id="pending">${spinner()}</div>`);
    log.scrollTop = log.scrollHeight;
    let reply;
    try {
      if (aiEnabled()) {
        const history = store.get().chat.slice(-16).map(({ role, content }) => ({ role, content }));
        reply = applyActions(await ask({ system: `${SYSTEM}\n\n# Student context\n${contextBlock(text)}`, messages: history, maxTokens: 1500 }));
      } else reply = localAnswer(text);
    } catch (e) {
      reply = `${e.message}\n\n${localAnswer(text)}`;
    }
    store.update((st) => st.chat.push({ role: 'assistant', content: reply || 'Done', ts: Date.now() }));
    busy = false;
    drawLog();
    input.focus();
  }

  el.querySelector('#send').onclick = send;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
  el.querySelector('#clear').onclick = () => { store.update((st) => (st.chat = [])); drawLog(); };

  drawLog();
  const pre = sessionStorage.getItem(PREFILL_KEY);
  if (pre) { sessionStorage.removeItem(PREFILL_KEY); input.value = pre; send(); }
  else input.focus();
}
