// Notes: generate structured notes from lecture text / slides / readings (AI or offline), edit in markdown.
import { store, getCourse, courseColor } from './store.js';
import { aiEnabled, ask, modelInfo } from './ai.js';
import { mountModelPicker } from './modelpicker.js';
import { esc, md, uid, fmtDate, todayISO } from './util.js';
import { modal, toast, readFilesText, enableImagePaste, ACCEPT, spinner } from './ui.js';
import { askAbout } from './chat.js';
import { makePrep, prepFor, upcomingExams } from './examprep.js';
import { printDoc } from './careers.js';
import { daysUntil } from './util.js';

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
let openFolder = null; // course id of the folder you're looking at ('' = general)
const collapsed = new Set();

// Guess a course from a note's title/body (for "sort into folders")
function guessCourse(n, courses) {
  const hay = `${n.title}\n${n.body.slice(0, 3000)}`.toUpperCase().replace(/\s+/g, ' ');
  const tight = hay.replace(/[\s-]/g, '');
  return courses.find((c) => c.code && tight.includes(c.code.toUpperCase().replace(/[\s-]/g, '')))
    || courses.find((c) => c.name && c.name.length > 5 && hay.includes(c.name.toUpperCase()));
}

export function render(el) {
  const pre = sessionStorage.getItem('studyos:open-note');
  if (pre) { sessionStorage.removeItem('studyos:open-note'); selectedId = pre; editing = false; }

  const draw = () => {
    const s = store.get();
    const notes = [...s.notes].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!selectedId || !notes.find((n) => n.id === selectedId)) selectedId = notes.find((n) => openFolder == null || (n.courseId || '') === openFolder)?.id || notes[0]?.id || null;
    const note = notes.find((n) => n.id === selectedId);
    if (note) openFolder = note.courseId || '';
    const known = new Set(s.courses.map((c) => c.id));
    const folders = [
      ...s.courses.map((c) => ({ id: c.id, name: c.code || c.name, sub: c.code && c.name !== c.code ? c.name : '', color: c.color })),
      { id: '', name: 'general', sub: 'not tied to a course', color: 'var(--faint)' },
    ];
    const inFolder = (fid) => notes.filter((n) => (known.has(n.courseId) ? n.courseId : '') === fid);
    const unsorted = inFolder('').filter((n) => !n.prep && guessCourse(n, s.courses));

    const noteItem = (n) => `<div class="note-item ${n.id === selectedId ? 'on' : ''} ${n.prep ? 'prep' : ''}" data-id="${n.id}">
      <div class="row spread" style="flex-wrap:nowrap"><span class="t">${esc(n.title)}</span>${n.prep ? `<span class="prep-tag">${n.prep.kind === 'practice' ? 'practice' : 'cheat sheet'}</span>` : ''}</div>
      <div class="s">${esc(n.body.replace(/^\s*(#+|>|[-*]\s+\[[ x]\]|[-*]|\d+\.)\s*/gim, '').replace(/[*`=]/g, '').replace(/\s+/g, ' ').slice(0, 110))}</div></div>`;

    const folderHTML = (f) => {
      const list = inFolder(f.id);
      if (!list.length && f.id === '' ) return '';
      const exam = f.id ? upcomingExams(f.id)[0] : null;
      const hasPrep = exam && prepFor(exam.id).length;
      const isOpen = !collapsed.has(f.id);
      const prep = list.filter((n) => n.prep).sort((a, b) => (a.prep.kind === 'cheatsheet' ? -1 : 1));
      const rest = list.filter((n) => !n.prep);
      return `<div class="nfolder ${isOpen ? 'open' : ''}" data-folder="${esc(f.id)}">
        <button class="nfolder-head" data-fold="${esc(f.id)}">
          <span class="chev ${isOpen ? 'down' : ''}"></span><span class="dot-c" style="background:${f.color}"></span>
          <span class="nf-name">${esc(f.name)}</span><span class="nf-count">${list.length}</span>
        </button>
        ${isOpen ? `
          ${exam ? `<div class="nf-exam">${esc(exam.title)} · ${daysUntil(exam.date) === 0 ? 'today' : `in ${daysUntil(exam.date)}d`}
            ${hasPrep ? '' : rest.length ? `<button class="link-btn" data-prep="${exam.id}">make cheat sheet + practice test</button>` : '<span class="faint">add notes to get exam prep</span>'}</div>` : ''}
          ${prep.map(noteItem).join('')}${rest.map(noteItem).join('')}
          ${list.length ? '' : '<div class="small faint" style="padding:6px 10px 10px">empty folder</div>'}
          <button class="link-btn nf-new" data-new="${esc(f.id)}">+ new page here</button>` : ''}
      </div>`;
    };

    el.innerHTML = `
      <div class="page-head">
        <div><div class="kicker">notes · ${notes.length} saved · ${s.courses.length} course folder${s.courses.length === 1 ? '' : 's'}</div><h1>the <em>notebook</em></h1><p>a folder for every course. paste a lecture or upload slides and get clean study notes back, plus a cheat sheet and practice test before each exam.</p></div>
        <div class="row"><button class="btn ghost sm" id="blank">+ blank page</button><button class="btn sm" id="gen">generate notes</button></div>
      </div>
      <div class="notes-layout">
        <div class="card" style="padding:12px">
          <input id="search" placeholder="search all notes…" style="margin-bottom:8px">
          ${unsorted.length ? `<button class="btn ghost sm" id="sort" style="width:100%;margin-bottom:8px;justify-content:center">sort ${unsorted.length} general note${unsorted.length === 1 ? '' : 's'} into course folders</button>` : ''}
          <div class="note-list" id="list">${notes.length || s.courses.length ? folders.map(folderHTML).join('') : '<div class="empty"><span class="big">empty.</span>import a syllabus and each course gets its own folder</div>'}</div>
        </div>
        <div class="card paper-sheet" id="pane">
          ${note ? `
            <div class="row spread" style="margin-bottom:10px">
              <label class="small muted row" style="gap:6px">folder
                <select id="move" class="move-sel">${folders.map((f) => `<option value="${esc(f.id)}" ${(known.has(note.courseId) ? note.courseId : '') === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
                · updated ${fmtDate(new Date(note.updatedAt).toISOString().slice(0, 10))}${note.prep ? ` · ${note.prep.by === 'ai' ? 'written by ai' : 'basic version'} from your notes` : ''}
              </label>
              <div class="row">
                ${note.prep ? '<button class="btn ghost sm" id="regen">remake</button>' : ''}
                <button class="btn ghost sm" id="pdf">pdf</button>
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
    $('#gen').onclick = () => openGenerator(openFolder);
    $('#gen2')?.addEventListener('click', () => openGenerator(openFolder));
    const newPage = (fid) => {
      const id = uid();
      store.update((st) => st.notes.push({ id, title: 'Untitled', courseId: fid || '', body: '', createdAt: Date.now(), updatedAt: Date.now() }));
      selectedId = id; editing = true; collapsed.delete(fid || ''); draw();
    };
    $('#blank').onclick = () => newPage(openFolder);
    el.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newPage(b.dataset.new)));
    el.querySelectorAll('[data-fold]').forEach((b) => (b.onclick = () => { const f = b.dataset.fold; collapsed.has(f) ? collapsed.delete(f) : collapsed.add(f); draw(); }));
    el.querySelectorAll('.note-item').forEach((n) => (n.onclick = () => { selectedId = n.dataset.id; editing = false; draw(); }));
    el.querySelectorAll('[data-prep]').forEach((b) => (b.onclick = async () => {
      const exam = store.get().events.find((e) => e.id === b.dataset.prep);
      b.disabled = true; b.textContent = 'making your prep…';
      const id = await makePrep(exam);
      if (id) { selectedId = id; editing = false; }
      draw();
    }));
    $('#sort')?.addEventListener('click', () => {
      let moved = 0;
      store.update((st) => st.notes.forEach((n) => { if (!known.has(n.courseId) && !n.prep) { const c = guessCourse(n, st.courses); if (c) { n.courseId = c.id; moved++; } } }));
      toast(`moved ${moved} note${moved === 1 ? '' : 's'} into course folders`);
      draw();
    });
    $('#search').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      el.querySelectorAll('.nfolder').forEach((f) => {
        let any = false;
        f.querySelectorAll('.note-item').forEach((n) => {
          const nt = s.notes.find((x) => x.id === n.dataset.id);
          const hit = !q || (nt.title + nt.body).toLowerCase().includes(q);
          n.style.display = hit ? '' : 'none';
          any ||= hit;
        });
        f.style.display = !q || any ? '' : 'none';
      });
    };
    if (!note) return;
    const save = (patch) => store.update((st) => Object.assign(st.notes.find((x) => x.id === note.id), patch, { updatedAt: Date.now() }));
    $('#move').onchange = (e) => { save({ courseId: e.target.value }); collapsed.delete(e.target.value); toast(`moved to ${e.target.selectedOptions[0].textContent}`); draw(); };
    $('#title').onchange = (e) => { save({ title: e.target.value.trim() || 'Untitled' }); draw(); };
    $('#edit').onclick = () => {
      if (editing) save({ body: $('#body').value });
      editing = !editing; draw();
    };
    $('#body')?.addEventListener('input', (e) => { clearTimeout($('#body')._t); $('#body')._t = setTimeout(() => save({ body: e.target.value }), 400); });
    $('#quiz').onclick = () => askAbout(`Quiz me on my note "${note.title}". Ask one question at a time and wait for my answer.`);
    $('#pdf').onclick = () => printDoc(`## ${note.title}\n\n${note.body}`, note.title);
    $('#regen')?.addEventListener('click', async () => {
      const exam = store.get().events.find((e) => e.id === note.prep.examId);
      if (!exam) return toast('that exam isn’t on your calendar anymore');
      $('#regen').disabled = true; $('#regen').textContent = 'remaking…';
      editing = false;
      const id = await makePrep(exam, { replace: true });
      if (id) selectedId = note.prep.kind === 'practice' ? store.get().notes.find((n) => n.prep?.examId === exam.id && n.prep.kind === 'practice')?.id || id : id;
      draw();
    });
    $('#del').onclick = () => {
      const snap = { ...note };
      store.update((st) => (st.notes = st.notes.filter((x) => x.id !== note.id)));
      selectedId = null; draw();
      toast('note deleted', { action: 'undo', onAction: () => { store.update((st) => st.notes.push(snap)); selectedId = snap.id; draw(); } });
    };
  };

  function openGenerator(folderId) {
    const courses = store.get().courses;
    modal('generate notes', `
      <label class="drop" id="g-drop" style="padding:18px"><input type="file" id="g-file" accept="${ACCEPT}" multiple hidden><b>upload slides, readings or photos</b><span class="muted small">pdf, powerpoint, word, photos of the whiteboard… · or paste below (screenshots too)</span></label>
      <textarea id="g-text" placeholder="Paste lecture transcript, slides text, or reading…" style="min-height:180px"></textarea>
      <div class="row">
        <label class="field">Title<input id="g-title" placeholder="e.g. Lecture 5: Memory"></label>
        <label class="field">folder<select id="g-course"><option value="">general</option>${courses.map((c) => `<option value="${c.id}" ${c.id === folderId ? 'selected' : ''}>${esc(c.code || c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="row spread">
        <div class="seg" id="g-style">${Object.entries(STYLES).map(([k, v], i) => `<button data-s="${k}" class="${i === 0 ? 'on' : ''}">${v}</button>`).join('')}</div>
      </div>
      <div class="row spread"><span class="small muted">${aiEnabled() ? `<span class="row" style="gap:8px">written by <span id="g-picker"></span> · can take 10–30s</span>` : 'Offline mode: extractive notes. Connect Kiro or an AI key for AI-written notes.'}</span><button class="btn" id="g-go">generate</button></div>
      <div id="g-status"></div>`, {
      wide: true,
      onMount(body, close) {
        const $ = (q) => body.querySelector(q);
        let style = 'outline';
        const unmount = body.querySelector('#g-picker') ? mountModelPicker(body.querySelector('#g-picker'), { compact: true }) : () => {};
        body.closest('.modal-backdrop')?.addEventListener('transitionend', () => { if (!document.body.contains(body)) unmount(); });
        body.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => { style = b.dataset.s; body.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('on', x === b)); }));
        const gStatus = (m) => ($('#g-status').innerHTML = spinner(m));
        const loadFiles = async (files) => {
          if (!files?.length) return;
          try {
            $('#g-text').value = await readFilesText(files, { onProgress: gStatus });
            if (!$('#g-title').value) $('#g-title').value = files[0].name.replace(/\.[^.]+$/, '');
          } catch (err) { toast(err.message, { timeout: 8000 }); }
          $('#g-status').innerHTML = '';
        };
        $('#g-file').onchange = (e) => loadFiles(e.target.files);
        const gDrop = $('#g-drop');
        ['dragenter', 'dragover'].forEach((ev) => gDrop.addEventListener(ev, (e) => { e.preventDefault(); gDrop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach((ev) => gDrop.addEventListener(ev, (e) => { e.preventDefault(); gDrop.classList.remove('over'); }));
        gDrop.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));
        enableImagePaste($('#g-text'), { onProgress: gStatus, onDone: () => ($('#g-status').innerHTML = ''), onError: (e) => { $('#g-status').innerHTML = ''; toast(e.message); } });
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
          selectedId = id; editing = false; collapsed.delete($('#g-course').value);
          close(); draw();
          toast('notes ready');
        };
      },
    });
  }

  draw();
}
