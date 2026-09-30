// Notes: generate structured notes from lecture text / slides / readings (AI or offline), edit in markdown.
import { store, getCourse, courseColor } from './store.js';
import { aiEnabled, ask, getStatus } from './ai.js';
import { esc, md, uid, fmtDate, todayISO } from './util.js';
import { modal, toast, readFileText, spinner } from './ui.js';
import { askAbout } from './chat.js';

const STYLES = {
  outline: 'Structured outline',
  cornell: 'Cornell notes',
  summary: 'One-page summary',
  flashcards: 'Flashcards',
};

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its just may more most much must no not of on or our out over so some such than that the their them then there these they this those to too under up us was we were what when where which while who why will with would you your also each other only very about after again all am any because before being below between both down during few further here itself let me my myself nor off once ours own same she should thats theirs themselves through until yours one two use used using like well get make many new way'.split(' '));

function sentences(text) {
  // Split per line first so headings don't glue onto the next sentence.
  return text
    .split(/\n+/)
    .flatMap((l) => l.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)/g) || [])
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && s.length < 400);
}
const DEF_RE = /\b(is|are|refers to|is defined as|means)\b/i;
const defTerm = (s) => s.split(DEF_RE)[0].replace(/^(the|a|an)\s+/i, '').trim();
const isDefinition = (s) => {
  const t = defTerm(s);
  return DEF_RE.test(s) && t.length > 1 && t.split(/\s+/).length <= 4 && !/^(research|studies|this|it|there|that|these|they|we|he|she)\b/i.test(t);
};
function keywords(text, n = 10) {
  const freq = {};
  for (const w of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

// Offline extractive note generator.
export function generateLocal(text, style, title) {
  const sents = sentences(text);
  const keys = keywords(text, 12);
  const score = (s) => keys.reduce((a, k) => a + (s.toLowerCase().includes(k) ? 1 : 0), 0) / Math.sqrt(s.split(' ').length);
  const top = sents.map((s, i) => ({ s, i, v: score(s) })).sort((a, b) => b.v - a.v).slice(0, 6).sort((a, b) => a.i - b.i).map((x) => x.s);
  const defs = sents.filter(isDefinition).slice(0, 8);
  const heads = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3 && l.length < 60 && !/[.,;]$/.test(l) && (/^#/.test(l) || /^[A-Z0-9][^a-z]*$/.test(l) || /^\d+[.)]\s/.test(l) || /^[A-Z][\w\s:&-]+$/.test(l))).slice(0, 10);
  const term = (s) => { const t = defTerm(s).slice(0, 60); return /^[A-Z]{2,}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1); };
  const questions = defs.map((d) => `What is ${term(d)}?`);

  if (style === 'flashcards') {
    const cards = defs.length ? defs : top;
    return `## ${title} · Flashcards\n\n${cards.map((c, i) => `**Q${i + 1}. ${defs.length ? `What is ${term(c)}?` : 'Explain:'}**\n> ${c}\n`).join('\n')}`;
  }
  if (style === 'cornell') {
    return `## ${title}\n\n### Cues / Questions\n${(questions.length ? questions : keys.slice(0, 5).map((k) => `What is the role of ${k}?`)).map((q) => `- ${q}`).join('\n')}\n\n### Notes\n${top.map((s) => `- ${s}`).join('\n')}\n\n### Summary\n${top.slice(0, 2).join(' ')}\n`;
  }
  if (style === 'summary') {
    return `## ${title}\n\n${top.join(' ')}\n\n**Key terms:** ${keys.slice(0, 8).map((k) => `\`${k}\``).join(' ')}\n`;
  }
  return `## ${title}\n\n${heads.length ? `### Topics\n${heads.map((h) => `- ${h.replace(/^#+\s*/, '')}`).join('\n')}\n\n` : ''}### Key points\n${top.map((s) => `- ${s}`).join('\n')}\n\n### Key terms\n${keys.slice(0, 10).map((k) => `- **${k}**`).join('\n')}\n${defs.length ? `\n### Definitions\n${defs.map((d) => `- ${d}`).join('\n')}\n` : ''}\n### Review questions\n${(questions.length ? questions : ['Summarize the main idea in two sentences.']).map((q) => `- [ ] ${q}`).join('\n')}\n`;
}

async function generateAI(text, style, title) {
  const guide = {
    outline: 'A hierarchical outline with ## sections, bullet points, **bold** key terms, a "Key terms" glossary, and 5 "- [ ] " review questions at the end.',
    cornell: 'Cornell format: "### Cues / Questions" (bullets), "### Notes" (detailed bullets), "### Summary" (3-4 sentences).',
    summary: 'A tight one-page summary: 1 paragraph overview, then "### Must-know" bullets, then "### Common mistakes".',
    flashcards: 'Flashcards: each as "**Q: ...**" on one line followed by "> A: ..." on the next. 12-20 cards covering all key concepts.',
  }[style];
  return ask({
    system: `You turn raw lecture material into excellent student study notes in Markdown. ${guide} Use ==highlight== for the single most exam-relevant facts. Start with "## ${title}". Be accurate; do not invent facts not supported by the source.`,
    messages: [{ role: 'user', content: text.slice(0, 60000) }],
    maxTokens: 4000,
  });
}

let selectedId = null;
let editing = false;

export function render(el) {
  const draw = () => {
    const s = store.get();
    const notes = [...s.notes].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!selectedId || !notes.find((n) => n.id === selectedId)) selectedId = notes[0]?.id || null;
    const note = notes.find((n) => n.id === selectedId);
    el.innerHTML = `
      <div class="page-head">
        <div><div class="kicker">notes · ${notes.length} saved</div><h1>the <em>notebook</em></h1><p>paste a lecture or upload slides and get clean study notes back.</p></div>
        <div class="row"><button class="btn ghost sm" id="blank">+ blank page</button><button class="btn sm" id="gen">generate notes</button></div>
      </div>
      <div class="notes-layout">
        <div class="card" style="padding:12px">
          <input id="search" placeholder="Search notes…" style="margin-bottom:8px">
          <div class="note-list" id="list">
            ${notes.length ? notes.map((n) => `<div class="note-item ${n.id === selectedId ? 'on' : ''}" data-id="${n.id}">
              <div class="row spread"><span class="t">${esc(n.title)}</span>${n.courseId ? `<span class="dot-c" style="background:${courseColor(n.courseId)}"></span>` : ''}</div>
              <div class="s">${esc(n.body.replace(/^\s*(#+|>|[-*]\s+\[[ x]\]|[-*]|\d+\.)\s*/gim, '').replace(/[*`=]/g, '').replace(/\s+/g, ' ').slice(0, 120))}</div></div>`).join('') : '<div class="empty"><span class="big">empty.</span>no notes yet</div>'}
          </div>
        </div>
        <div class="card paper-sheet" id="pane">
          ${note ? `
            <div class="row spread" style="margin-bottom:10px">
              <span class="small muted">${esc(getCourse(note.courseId)?.name || 'general')} · updated ${fmtDate(new Date(note.updatedAt).toISOString().slice(0, 10))}</span>
              <div class="row">
                <button class="btn ghost sm" id="quiz">quiz me</button>
                <button class="btn ghost sm" id="edit">${editing ? 'done' : 'edit'}</button>
                <button class="icon-btn" id="del" title="Delete">delete</button>
              </div>
            </div>
            <input class="note-title" id="title" value="${esc(note.title)}">
            ${editing ? `<textarea class="editor" id="body">${esc(note.body)}</textarea>` : `<div class="prose">${md(note.body)}</div>`}
          ` : `<div class="cta"><div class="big">a blank page.</div><h3>your notes live here</h3><p class="muted">generate notes from lecture text or a pdf, or start from scratch.</p><button class="btn" id="gen2">generate notes</button></div>`}
        </div>
      </div>`;

    const $ = (q) => el.querySelector(q);
    $('#gen').onclick = openGenerator;
    $('#gen2')?.addEventListener('click', openGenerator);
    $('#blank').onclick = () => {
      const id = uid();
      store.update((st) => st.notes.push({ id, title: 'Untitled', courseId: '', body: '', createdAt: Date.now(), updatedAt: Date.now() }));
      selectedId = id; editing = true; draw();
    };
    el.querySelectorAll('.note-item').forEach((n) => (n.onclick = () => { selectedId = n.dataset.id; editing = false; draw(); }));
    $('#search').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      el.querySelectorAll('.note-item').forEach((n) => {
        const nt = s.notes.find((x) => x.id === n.dataset.id);
        n.style.display = (nt.title + nt.body).toLowerCase().includes(q) ? '' : 'none';
      });
    };
    if (!note) return;
    const save = (patch) => store.update((st) => Object.assign(st.notes.find((x) => x.id === note.id), patch, { updatedAt: Date.now() }));
    $('#title').onchange = (e) => { save({ title: e.target.value.trim() || 'Untitled' }); draw(); };
    $('#edit').onclick = () => {
      if (editing) save({ body: $('#body').value });
      editing = !editing; draw();
    };
    $('#body')?.addEventListener('input', (e) => { clearTimeout($('#body')._t); $('#body')._t = setTimeout(() => save({ body: e.target.value }), 400); });
    $('#quiz').onclick = () => askAbout(`Quiz me on my note "${note.title}". Ask one question at a time and wait for my answer.`);
    $('#del').onclick = () => {
      const snap = { ...note };
      store.update((st) => (st.notes = st.notes.filter((x) => x.id !== note.id)));
      selectedId = null; draw();
      toast('Note deleted', { action: 'Undo', onAction: () => { store.update((st) => st.notes.push(snap)); selectedId = snap.id; draw(); } });
    };
  };

  function openGenerator() {
    const courses = store.get().courses;
    modal('generate notes', `
      <label class="drop" id="g-drop" style="padding:18px"><input type="file" id="g-file" accept=".pdf,.txt,.md" hidden><b>upload slides or a reading</b><span class="muted small">pdf, txt · or paste below</span></label>
      <textarea id="g-text" placeholder="Paste lecture transcript, slides text, or reading…" style="min-height:180px"></textarea>
      <div class="row">
        <label class="field">Title<input id="g-title" placeholder="e.g. Lecture 5: Memory"></label>
        <label class="field">Course<select id="g-course"><option value="">General</option>${courses.map((c) => `<option value="${c.id}">${esc(c.code || c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="row spread">
        <div class="seg" id="g-style">${Object.entries(STYLES).map(([k, v], i) => `<button data-s="${k}" class="${i === 0 ? 'on' : ''}">${v}</button>`).join('')}</div>
      </div>
      <div class="row spread"><span class="small muted">${aiEnabled() ? `written by ${getStatus().provider === 'kiro' ? 'kiro' : 'ai'} · can take 10–30s` : 'Offline mode: extractive notes. Connect Kiro or an AI key for AI-written notes.'}</span><button class="btn" id="g-go">generate</button></div>
      <div id="g-status"></div>`, {
      wide: true,
      onMount(body, close) {
        const $ = (q) => body.querySelector(q);
        let style = 'outline';
        body.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { style = b.dataset.s; body.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === b)); }));
        $('#g-file').onchange = async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            $('#g-text').value = await readFileText(f);
            if (!$('#g-title').value) $('#g-title').value = f.name.replace(/\.[^.]+$/, '');
          } catch (err) { toast(err.message); }
        };
        $('#g-go').onclick = async () => {
          const text = $('#g-text').value.trim();
          if (text.length < 80) return toast('Add a bit more source material (at least a paragraph)');
          const title = $('#g-title').value.trim() || `Notes · ${fmtDate(todayISO())}`;
          $('#g-go').disabled = true;
          $('#g-status').innerHTML = spinner('Writing your notes…');
          let bodyMd;
          try {
            bodyMd = aiEnabled() ? await generateAI(text, style, title) : generateLocal(text, style, title);
          } catch (err) {
            toast(`AI failed (${err.message}), used offline generator`);
            bodyMd = generateLocal(text, style, title);
          }
          // The title is shown separately, so drop a leading "## Title" heading.
          bodyMd = bodyMd.trim().replace(/^#{1,3}\s+.*\n+/, (line) => (line.toLowerCase().includes(title.toLowerCase().slice(0, 12)) ? '' : line));
          const id = uid();
          store.update((st) => st.notes.push({ id, title, courseId: $('#g-course').value, body: bodyMd.trim(), source: text.slice(0, 20000), createdAt: Date.now(), updatedAt: Date.now() }));
          selectedId = id; editing = false;
          close(); draw();
          toast('notes ready');
        };
      },
    });
  }

  draw();
}
