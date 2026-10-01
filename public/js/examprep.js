// Exam prep: a few days before each exam, turn that course's notes into a cheat sheet + practice test.
import { store, getCourse } from './store.js';
import { aiEnabled, ask } from './ai.js';
import { uid, todayISO, daysUntil, fmtDate, EXAM_TYPES } from './util.js';
import { toast } from './ui.js';

const running = new Set();

export const prepDays = () => Number(store.get().settings.prepDays ?? 5);
export const courseNotes = (courseId) => store.get().notes.filter((n) => n.courseId === courseId && !n.prep);
export const prepFor = (examId) => store.get().notes.filter((n) => n.prep?.examId === examId);

export function upcomingExams(courseId) {
  const today = todayISO();
  return store.get().events
    .filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today && !e.done && (!courseId || e.courseId === courseId))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- offline builder (no AI): pulls the important bits out of the notes ----------
function localPrep(exam, notes) {
  const lines = notes.flatMap((n) => n.body.split('\n').map((l) => ({ l: l.trim(), note: n.title })));
  const strip = (l) => l.replace(/^[-*>\d.)\s]+/, '').replace(/\[[ x]\]\s*/i, '').trim();
  const bold = [...new Set(notes.flatMap((n) => [...n.body.matchAll(/\*\*([^*]{2,60})\*\*/g)].map((m) => m[1].trim())))].slice(0, 30);
  const marked = lines.filter(({ l }) => /==[^=]+==/.test(l)).map(({ l }) => strip(l).replace(/==/g, ''));
  const defs = lines.filter(({ l }) => /\b(is|are|refers to|is defined as|means)\b/i.test(l) && l.length < 260 && /^[-*]/.test(l)).map(({ l }) => strip(l)).slice(0, 25);
  const qs = lines.filter(({ l }) => /\?\s*$/.test(l) && l.length < 200).map(({ l }) => strip(l)).slice(0, 20);
  const heads = lines.filter(({ l }) => /^#{2,4}\s/.test(l)).map(({ l }) => l.replace(/^#+\s*/, '')).filter((h) => !/key terms|review questions|definitions|summary|topics|key points/i.test(h));
  const byNote = notes.map((n) => `- **${n.title}**`).join('\n');
  const sheet = `### Covers
${byNote}
${exam.notes ? `\n*From the syllabus:* ${exam.notes}\n` : ''}
${heads.length ? `### Topics\n${[...new Set(heads)].slice(0, 20).map((h) => `- ${h}`).join('\n')}\n` : ''}
${marked.length ? `### Most likely on the exam\n${marked.slice(0, 15).map((m) => `- ==${m}==`).join('\n')}\n` : ''}
${defs.length ? `### Definitions\n${defs.map((d) => `- ${d}`).join('\n')}\n` : ''}
${bold.length ? `### Key terms\n${bold.map((b) => `\`${b}\``).join(' · ')}\n` : ''}`;
  const termQs = bold.slice(0, 10).map((b) => `Define **${b}** and give an example.`);
  const practice = `### Practice questions
${[...qs, ...termQs].slice(0, 20).map((q, i) => `${i + 1}. ${q}`).join('\n') || '1. Summarize each topic above in two sentences without looking at your notes.'}

### Answer key
Check each answer against your notes:
${notes.map((n) => `- ${n.title}`).join('\n')}

> connect kiro or an ai key in .env to get full worked answers and exam-style questions.`;
  return { sheet: sheet.replace(/\n{3,}/g, '\n\n').trim(), practice };
}

async function aiPrep(exam, notes) {
  const course = getCourse(exam.courseId);
  const material = notes.map((n) => `# ${n.title}\n${n.body}\n${n.source ? `\n(source excerpt)\n${n.source.slice(0, 4000)}` : ''}`).join('\n\n---\n\n').slice(0, 60000);
  const reply = await ask({
    system: `You are an expert tutor preparing a student for an exam. Use ONLY the student's notes below. Do not invent facts that aren't in them.
Write two Markdown documents separated by a line containing exactly ===PRACTICE===
1) CHEAT SHEET: dense, one-page review. Sections with ### headings by topic; bullets; **bold** key terms; formulas/definitions verbatim from the notes; ==highlight== the facts most likely to be tested; end with "### Common mistakes".
2) PRACTICE TEST: ~15 exam-style questions mixing multiple choice (A–D), short answer, and 2 longer application questions, ordered easy → hard and grouped by topic. Then "### Answer key" with the correct answer and a 1–2 sentence explanation for each.
Don't start with a title heading.`,
    messages: [{ role: 'user', content: `Course: ${course?.code || ''} ${course?.name || ''}\nExam: ${exam.title} on ${exam.date}${exam.notes ? `\nSyllabus says it covers: ${exam.notes}` : ''}\n\nMy notes:\n${material}` }],
    maxTokens: 7000,
  });
  const [sheet, practice = ''] = reply.split(/^\s*===PRACTICE===\s*$/m);
  return { sheet: sheet.trim(), practice: practice.trim() || '### Practice questions\n(the ai didn’t return a practice test. try again)' };
}

// Make (or remake) the prep pack for one exam. Returns the cheat sheet note id.
export async function makePrep(exam, { replace = false, silent = false } = {}) {
  if (running.has(exam.id)) return null;
  const notes = courseNotes(exam.courseId);
  if (!notes.length) {
    if (!silent) toast('add some notes to this course first, then it can build your prep');
    return null;
  }
  running.add(exam.id);
  try {
    let docs;
    let by = 'offline';
    if (aiEnabled()) {
      try { docs = await aiPrep(exam, notes); by = 'ai'; } catch (e) { if (!silent) toast(`ai couldn’t make it (${e.message}), made a basic version`); }
    }
    docs ||= localPrep(exam, notes);
    const when = fmtDate(exam.date, { month: 'short', day: 'numeric' });
    const base = { courseId: exam.courseId, createdAt: Date.now(), updatedAt: Date.now() };
    const sheetId = uid();
    const prep = { examId: exam.id, examDate: exam.date, by, from: notes.map((n) => n.id) };
    store.update((s) => {
      if (replace) s.notes = s.notes.filter((n) => n.prep?.examId !== exam.id);
      s.notes.push(
        { ...base, id: sheetId, title: `Cheat sheet · ${exam.title}`, body: `*for ${exam.title} on ${when}, built from ${notes.length} note${notes.length === 1 ? '' : 's'}*\n\n${docs.sheet}`, prep: { ...prep, kind: 'cheatsheet' } },
        { ...base, id: uid(), title: `Practice test · ${exam.title}`, body: docs.practice, prep: { ...prep, kind: 'practice' } },
      );
    });
    toast(`exam prep ready for ${exam.title}`, { action: 'open', onAction: () => { sessionStorage.setItem('studyos:open-note', sheetId); location.hash = '#/notes'; } , timeout: 9000 });
    return sheetId;
  } finally {
    running.delete(exam.id);
  }
}

// Runs at startup and when you come back to the tab: build prep for exams that are N days out.
export async function autoPrep() {
  const s = store.get();
  if (s.settings.autoPrep === false) return;
  for (const ex of upcomingExams()) {
    const d = daysUntil(ex.date);
    if (d > prepDays() || d < 0) break;
    if (prepFor(ex.id).length || !courseNotes(ex.courseId).length) continue;
    await makePrep(ex, { silent: true });
  }
}
