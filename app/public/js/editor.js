// Transcript editor: correct text (timestamps are kept), name speakers,
// edit chapters and tagged sections, accept Claude suggestions, review auto-cut proposals.
const root = document.getElementById('editor');
const epId = root.dataset.episode;
const audioSrc = root.dataset.audio;

const STRINGS = JSON.parse(document.getElementById('i18n')?.textContent || '{}');
const t = (key, vars) => {
  let s = STRINGS[`editor.${key}`] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
};

const fmt = (sec) => {
  sec = Math.round(Math.max(0, sec || 0) * 10) / 10; // round first, so 0.96 s becomes 0:01, not 0:00.10
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const tenth = Math.round((sec % 1) * 10);
  const base = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return tenth ? `${base}.${tenth}` : base;
};
const parse = (str) => {
  const p = String(str).trim().replace(',', '.').split(':').map(Number);
  return p.some(Number.isNaN) ? NaN : p.reduce((a, x) => a * 60 + x, 0);
};

// h('tag.class', {attrs}, ...children)
function h(sel, attrs = {}, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let S = null;          // state from the server
let words = [];        // words being edited
let speakerNames = {};
let dirty = false;
let editMode = false;
let draft = null;      // open "new section/chapter" form: { kind, start, end, text }
let AC = null;         // auto-cut state from the server
let acFilter = 'all';  // which certainty groups are shown in the transcript
let cutMode = false;   // clicking a marked word switches its cut on/off
let preview = false;   // the player skips marked ranges

const audio = h('audio', { controls: true, preload: 'metadata', src: audioSrc });
const status = h('span.status', { 'aria-live': 'polite' });
const saveBtn = h('button.primary', { onclick: save, disabled: true }, t('saveTranscript'));
const transcriptEl = h('div.transcript.editing', { id: 'transcript' });
const panel = h('div.side');
const toolbar = h('div.seltool', { hidden: true, role: 'toolbar', 'aria-label': t('selection') });

function setDirty(v) {
  dirty = v; saveBtn.disabled = !v;
  status.textContent = v ? t('unsaved') : '';
}
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function load() {
  S = await api('GET', `/api/episodes/${epId}/editor`);
  AC = await api('GET', `/api/episodes/${epId}/autocut`).catch(() => null);
  words = S.transcript ? S.transcript.words.map((w) => ({ ...w })) : [];
  speakerNames = { ...S.episode.speakerNames };
  render();
}

function applyState(next) {
  // After chapter/section changes: keep local transcript edits
  S = { ...next, transcript: S.transcript ? { ...S.transcript, version: S.transcript.version } : next.transcript };
  renderPanel();
}

function render() {
  root.replaceChildren(
    h('div.titlerow', {}, h('h1', {}, t('pageTitle', { title: S.episode.title }))),
    h('div.editor-cols', {},
      h('div.main', {},
        h('div.sticky', {}, audio,
          h('div.inline', {},
            h('label.check', {}, h('input', { type: 'checkbox', id: 'editmode', onchange: (e) => { editMode = e.target.checked; if (editMode) setCutMode(false); renderTranscript(); } }), ' ', t('editText')),
            h('label.check.acopt', {}, h('input', { type: 'checkbox', id: 'cutmode', onchange: (e) => setCutMode(e.target.checked) }), ' ', t('acEditCuts')),
            h('label.check.acopt', {}, h('input', { type: 'checkbox', id: 'preview', onchange: (e) => setPreview(e.target.checked) }), ' ', t('acPreview')),
            h('label.check', {}, h('input', { type: 'checkbox', checked: true, onchange: (e) => transcriptEl.classList.toggle('hidefill', !e.target.checked) }), ' ', t('showFillers')),
            saveBtn, status),
          h('p.muted.small', {}, t('help'))),
        S.transcript ? transcriptEl : h('p', {}, t('noTranscript'))),
      panel),
    toolbar);
  renderTranscript();
  renderPanel();
}

// ---------- Transcript ----------
function paragraphs() {
  const out = []; let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (!cur || w.sp !== cur.sp || (prev && w.s - prev.e > 1.5) || (cur.idx.length > 60 && /[.!?]$/.test(prev?.w || ''))) { cur = { sp: w.sp, idx: [] }; out.push(cur); }
    cur.idx.push(i);
  });
  return out;
}

// ---------- Auto-cut marks ----------
const GROUP_LABEL = { certain: 'acCertain', likely: 'acLikely', unsure: 'acUnsure', own: 'acOwn' };
const shown = (c) => acFilter === 'all' || acFilter === c.group || c.group === 'own';

// Which word belongs to which proposed cut, and after which word a pause marker goes (matched by time)
function cutMarks() {
  const byWord = new Map(), pauseAfter = new Map();
  if (!AC?.active || acFilter === 'none') return { byWord, pauseAfter };
  const firstFrom = (time) => { let lo = 0, hi = words.length; while (lo < hi) { const m = (lo + hi) >> 1; if (words[m].s < time) lo = m + 1; else hi = m; } return lo; };
  for (const c of AC.cuts) {
    if (!shown(c)) continue;
    if (c.type === 'pause') {
      const i = firstFrom(c.end) - 1;
      if (i >= 0) pauseAfter.set(i, c);
      continue;
    }
    for (let i = firstFrom(c.start - 0.001); i < words.length && words[i].e <= c.end + 0.001; i++) byWord.set(i, c);
  }
  return { byWord, pauseAfter };
}

const cutClass = (c) => `ac ac-${c.group}${c.marked ? ' ac-on' : ''}${c.manual ? ' ac-manual' : ''}`;
const cutTitle = (c) => [t(GROUP_LABEL[c.group]), ...c.reasons.map((r) => t('acReason.' + r)), c.marked ? t('acWillCut') : t('acWillKeep')].join(' · ');

async function toggleCut(id) {
  const c = AC.cuts.find((x) => x.id === id);
  if (!c) return;
  const want = !c.marked;
  // Back to the automatic decision if that is what the user now wants
  const value = want === c.on ? null : want;
  try { AC = await api('PUT', `/api/episodes/${epId}/autocut`, { overrides: { [id]: value } }); renderTranscript(); renderPanel(); }
  catch (e) { alert(e.message); }
}

function setCutMode(on) {
  cutMode = on;
  const box = document.getElementById('cutmode');
  if (box) box.checked = on;
  if (on && editMode) { editMode = false; const em = document.getElementById('editmode'); if (em) em.checked = false; }
  transcriptEl.classList.toggle('cutmode', on);
  renderTranscript();
}

// Preview: while playing, jump over every marked range
let rafId = 0;
function setPreview(on) {
  preview = on;
  cancelAnimationFrame(rafId);
  if (on) rafId = requestAnimationFrame(skipLoop);
}
function skipLoop() {
  if (!preview) return;
  if (!audio.paused && AC?.ranges?.length) {
    const time = audio.currentTime;
    const r = AC.ranges.find((x) => time >= x.start && time < x.end - 0.01);
    if (r) audio.currentTime = r.end;
  }
  rafId = requestAnimationFrame(skipLoop);
}

function renderTranscript() {
  const speakers = Object.keys(speakerNames);
  transcriptEl.classList.toggle('editmode', editMode);
  const { byWord, pauseAfter } = cutMarks();
  transcriptEl.replaceChildren(...paragraphs().map((p) => {
    const first = words[p.idx[0]];
    const who = editMode && speakers.length
      ? h('select.who', { 'aria-label': t('speakerForParagraph'), onchange: (e) => { p.idx.forEach((i) => { words[i].sp = e.target.value; }); setDirty(true); renderTranscript(); } },
        speakers.map((sp) => h('option', { value: sp, selected: sp === p.sp }, speakerNames[sp] || sp)))
      : h('span.who', {}, speakerNames[p.sp] || p.sp || '');
    const para = h('p.para', {}, who, h('button.ts.linkbtn', { onclick: () => seek(first.s) }, fmt(first.s)), ' ');
    p.idx.forEach((i) => {
      const w = words[i];
      const low = w.c != null && w.c < 0.5;
      const c = byWord.get(i);
      const cls = [w.f ? 'f' : '', low ? 'low' : '', c ? cutClass(c) : ''].join(' ').trim();
      const title = `${fmt(w.s)}–${fmt(w.e)}${low ? ' · ' + t('lowConfidence') : ''}${c ? ' · ' + cutTitle(c) : ''}`;
      para.append(h('span', { 'data-i': i, 'data-cut': c?.id, class: cls || null, title }, w.w), ' ');
      const pc = pauseAfter.get(i);
      if (pc && words[i + 1]) {
        const gap = words[i + 1].s - w.e;
        const after = gap - (pc.end - pc.start);
        para.append(h(`button.acp.${cutClass(pc).split(' ').join('.')}`, { type: 'button', 'data-cut': pc.id, title: cutTitle(pc),
          'aria-pressed': pc.marked ? 'true' : 'false', onclick: () => toggleCut(pc.id) },
        `⏸ ${gap.toFixed(1)} s${pc.marked ? ` → ${after.toFixed(1)} s` : ''}`), ' ');
      }
    });
    return para;
  }));
}

const seek = (sec) => { audio.currentTime = sec; audio.play().catch(() => {}); };

transcriptEl.addEventListener('click', (e) => {
  const span = e.target.closest('span[data-i]');
  if (!span) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  const i = Number(span.dataset.i);
  if (cutMode && span.dataset.cut) { toggleCut(span.dataset.cut); return; }
  if (editMode) editWord(span, i); else seek(words[i].s);
});

function editWord(span, i) {
  const w = words[i];
  const input = h('input.wordedit', { value: w.w, size: Math.max(4, w.w.length + 2), 'aria-label': t('editWord') });
  span.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (ok) => {
    if (done) return; done = true;
    const val = input.value.trim();
    if (ok && val !== w.w) {
      const parts = val ? val.split(/\s+/) : [];
      // Spread the original word's time evenly over the new words
      const step = (w.e - w.s) / Math.max(1, parts.length);
      const repl = parts.map((txt, k) => ({ ...w, w: txt, s: +(w.s + step * k).toFixed(3), e: +(w.s + step * (k + 1)).toFixed(3), f: 0, c: undefined }));
      words.splice(i, 1, ...repl);
      setDirty(true);
    }
    renderTranscript();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
    if (e.key === 'Tab') {
      e.preventDefault(); commit(true);
      const next = transcriptEl.querySelector(`span[data-i="${e.shiftKey ? i - 1 : i + 1}"]`);
      if (next) editWord(next, Number(next.dataset.i));
    }
  });
  input.addEventListener('blur', () => commit(true));
}

// Highlight the word being played
audio.addEventListener('timeupdate', () => {
  const time = audio.currentTime + 0.05;
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].s <= time) { ans = m; lo = m + 1; } else hi = m - 1; }
  transcriptEl.querySelector('span.on')?.classList.remove('on');
  transcriptEl.querySelector(`span[data-i="${ans}"]`)?.classList.add('on');
});

// Text selection -> floating toolbar
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !transcriptEl.contains(sel.anchorNode)) { toolbar.hidden = true; return; }
  const range = selectedRange();
  if (!range) { toolbar.hidden = true; return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const keep = (e) => e.preventDefault(); // keep the selection when clicking toolbar buttons
  const allHes = range.idx.every((i) => words[i].f);
  const speakers = Object.keys(speakerNames);
  const sameSp = range.idx.every((i) => words[i].sp === words[range.idx[0]].sp) ? words[range.idx[0]].sp : '';
  toolbar.replaceChildren(
    h('span.small', {}, `${fmt(range.start)}–${fmt(range.end)}`),
    h('button', { onmousedown: keep, onclick: () => ownCut('cut', range) }, '✂ ', t('cutSelection')),
    h('button', { onmousedown: keep, onclick: () => ownCut('keep', range) }, '↺ ', t('keepSelection')),
    h('button', { onmousedown: keep, onclick: () => setWords(range.idx, (w) => { w.f = allHes ? 0 : 1; }) }, allHes ? t('unmarkHesitation') : t('markHesitation')),
    speakers.length > 1 ? h('span.small', {}, t('assignSpeaker')) : null,
    ...(speakers.length > 1 ? speakers.map((sp) => h('button', { onmousedown: keep, 'aria-pressed': sp === sameSp ? 'true' : 'false', disabled: sp === sameSp,
      onclick: () => setWords(range.idx, (w) => { w.sp = sp; }) }, speakerNames[sp] || sp)) : []),
    h('button', { onmousedown: keep, onclick: () => newSection(range) }, '+ ', t('addSection')),
    h('button', { onmousedown: keep, onclick: () => newChapter(range.start) }, '+ ', t('addChapterHere')),
    h('button', { onmousedown: keep, onclick: () => { audio.currentTime = range.start; audio.play(); } }, '▶ ', t('preview')));
  toolbar.hidden = false;
  toolbar.style.top = `${scrollY + rect.top - toolbar.offsetHeight - 6}px`;
  toolbar.style.left = `${Math.max(8, rect.left)}px`;
});

function selectedRange() {
  const sel = getSelection();
  const r = sel.getRangeAt(0);
  const spans = [...transcriptEl.querySelectorAll('span[data-i]')].filter((s) => r.intersectsNode(s));
  if (!spans.length) return null;
  const idx = spans.map((s) => Number(s.dataset.i));
  const a = words[idx[0]], b = words[idx.at(-1)];
  return { start: a.s, end: b.e, idx, text: spans.map((s) => s.textContent).join(' ') };
}

// Right-click on a word: select it, so the toolbar appears (instead of the browser's menu)
transcriptEl.addEventListener('contextmenu', (e) => {
  const span = e.target.closest('span[data-i]');
  if (!span || editMode) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.getRangeAt(0).intersectsNode(span)) { e.preventDefault(); return; }
  e.preventDefault();
  const r = document.createRange();
  r.selectNodeContents(span);
  sel.removeAllRanges(); sel.addRange(r);
});

function clearSelection() { toolbar.hidden = true; getSelection().removeAllRanges(); }

// Own cut of any selected words, or "don't cut" for everything in the selection
async function ownCut(kind, range) {
  clearSelection();
  if (dirty) await save(); // the cut refers to the saved words
  acAct(() => api('PUT', `/api/episodes/${epId}/autocut`, { [kind]: { start: range.start, end: range.end } }));
}

// Change selected words (hesitation flag, speaker) and save right away, so auto-cut sees it
function setWords(idx, fn) {
  clearSelection();
  idx.forEach((i) => fn(words[i]));
  setDirty(true);
  renderTranscript();
  save();
}

async function save() {
  saveBtn.disabled = true; status.textContent = t('saving');
  try {
    const r = await api('PUT', `/api/episodes/${epId}/transcript`, { words, version: S.transcript.version, speakerNames });
    S.transcript.version = r.version;
    setDirty(false);
    AC = await api('GET', `/api/episodes/${epId}/autocut`).catch(() => AC);
    renderTranscript(); renderPanel();
    status.textContent = r.conflict ? t('savedConflict', { name: r.conflictBy || t('someoneElse') }) : t('saved');
  } catch (e) { status.textContent = e.message; saveBtn.disabled = false; }
}

// ---------- Side panel ----------
async function act(fn) {
  try { const st = await fn(); if (st) applyState(st); }
  catch (e) { alert(e.message); }
}

function newSection(range) {
  toolbar.hidden = true; getSelection().removeAllRanges();
  draft = { kind: 'section', ...range };
  renderPanel();
  panel.querySelector('.draft input[name=tags]')?.focus();
}

function newChapter(start) {
  toolbar.hidden = true; getSelection().removeAllRanges();
  draft = { kind: 'chapter', start };
  renderPanel();
  panel.querySelector('.draft input[name=title]')?.focus();
}

function draftForm() {
  if (!draft) return null;
  const isSec = draft.kind === 'section';
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const start = parse(f.get('start')), end = parse(f.get('end'));
    const body = isSec
      ? { start, end, title: f.get('title'), tags: String(f.get('tags')).split(',').map((x) => x.trim()).filter(Boolean) }
      : { start, title: f.get('title'), summary: f.get('summary') };
    if (!isSec && !body.title.trim()) return;
    draft = null;
    await act(() => api('POST', `/api/episodes/${epId}/${isSec ? 'sections' : 'chapters'}`, body));
  };
  return h('form.box.draft', { onsubmit: submit, 'aria-label': isSec ? t('newSection') : t('newChapter') },
    h('h2', {}, isSec ? t('newSection') : t('newChapter')),
    draft.text ? h('p.small.muted', {}, `“${draft.text.slice(0, 160)}${draft.text.length > 160 ? ' …' : ''}”`) : null,
    h('div.inline', {},
      h('label', {}, t('start'), ' ', h('input.time', { name: 'start', value: fmt(draft.start) })),
      isSec ? h('label', {}, t('end'), ' ', h('input.time', { name: 'end', value: fmt(draft.end) })) : null),
    h('label', {}, isSec ? t('titleOptional') : t('title'), h('input', { name: 'title', required: !isSec })),
    isSec ? h('label', {}, t('tagsComma'), h('input', { name: 'tags', list: 'alltags', placeholder: S.allTags.slice(0, 4).join(', ') }))
      : h('label', {}, t('summary'), h('textarea', { name: 'summary', rows: 2 })),
    h('div.inline', {}, h('button.primary', { type: 'submit' }, t('create')),
      h('button', { type: 'button', onclick: () => { draft = null; renderPanel(); } }, t('cancel'))));
}

function timeInput(value, onchange, label) {
  return h('input.time', { value: fmt(value), size: 8, 'aria-label': label, onchange: (e) => { const v = parse(e.target.value); if (Number.isFinite(v)) onchange(v); else e.target.value = fmt(value); } });
}

function renderPanel() {
  const proposals = S.chapters.filter((c) => !c.accepted).length + S.sections.filter((s) => !s.accepted).length;
  const claudeBtn = h('button', {
    disabled: !S.claude || !S.transcript,
    title: S.claude ? '' : t('noClaude'),
    onclick: async (e) => {
      if (proposals && !confirm(t('replaceProposals'))) return;
      e.target.disabled = true; e.target.textContent = t('claudeThinking');
      await act(() => api('POST', `/api/episodes/${epId}/suggestions`));
      e.target.disabled = false; e.target.textContent = t('getSuggestions');
    },
  }, t('getSuggestions'));

  const chapterRow = (c) => h(`li.item${c.accepted ? '' : '.proposal'}`, {},
    h('div.inline', {},
      h('button.linkbtn', { onclick: () => seek(c.start), 'aria-label': t('playFromChapter') }, '▶'),
      timeInput(c.start, (v) => act(() => api('PUT', `/api/chapters/${c.id}`, { start: v })), t('start')),
      h('input.grow', { value: c.title, 'aria-label': t('chapterTitle'), onchange: (e) => act(() => api('PUT', `/api/chapters/${c.id}`, { title: e.target.value })) }),
      c.accepted ? null : h('button.small', { onclick: () => act(() => api('PUT', `/api/chapters/${c.id}`, { accepted: true })) }, t('accept')),
      h('button.linkbtn.danger', { onclick: () => act(() => api('DELETE', `/api/chapters/${c.id}`)) }, c.accepted ? t('delete') : t('reject'))),
    h('textarea', { rows: 2, 'aria-label': t('summary'), placeholder: t('summaryPlaceholder'), onchange: (e) => act(() => api('PUT', `/api/chapters/${c.id}`, { summary: e.target.value })) }, c.summary),
    c.accepted ? null : h('small.muted', {}, t('fromClaude')));

  const sectionRow = (s) => h(`li.item${s.accepted ? '' : '.proposal'}`, {},
    h('div.inline', {},
      h('button.linkbtn', { onclick: () => seek(s.start), 'aria-label': t('playSection') }, '▶'),
      timeInput(s.start, (v) => act(() => api('PUT', `/api/sections/${s.id}`, { start: v })), t('start')), '–',
      timeInput(s.end, (v) => act(() => api('PUT', `/api/sections/${s.id}`, { end: v })), t('end')),
      s.accepted ? null : h('button.small', { onclick: () => act(() => api('PUT', `/api/sections/${s.id}`, { accepted: true })) }, t('accept')),
      h('button.linkbtn.danger', { onclick: () => act(() => api('DELETE', `/api/sections/${s.id}`)) }, s.accepted ? t('delete') : t('reject'))),
    h('input', { value: s.title, placeholder: t('title'), 'aria-label': t('sectionTitle'), onchange: (e) => act(() => api('PUT', `/api/sections/${s.id}`, { title: e.target.value })) }),
    h('input', { value: s.tags.join(', '), list: 'alltags', placeholder: t('tagsComma'), 'aria-label': t('tags'),
      onchange: (e) => act(() => api('PUT', `/api/sections/${s.id}`, { tags: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })) }),
    s.accepted ? null : h('small.muted', {}, t('fromClaude')));

  const speakerInputs = Object.keys(speakerNames).map((sp) => h('label', {}, `${sp}: `,
    h('input', { value: speakerNames[sp], onchange: (e) => { speakerNames[sp] = e.target.value.trim() || sp; setDirty(true); renderTranscript(); } })));

  panel.replaceChildren(...[
    draftForm(),
    autocutBox(),
    h('section.box', {}, h('h2', {}, t('suggestions')), claudeBtn,
      proposals ? h('p', {}, t('openProposals', { n: proposals }), ' ',
        h('button.small', { onclick: () => act(() => api('POST', `/api/episodes/${epId}/suggestions/accept-all`, {})) }, t('acceptAll'))) : null),
    h('section.box', {}, h('h2', {}, t('speakers')), ...speakerInputs, h('p.muted.small', {}, t('speakersHint'))),
    h('section.box', {}, h('div.titlerow', {}, h('h2', {}, t('chaptersCount', { n: S.chapters.length })),
      h('button.small', { onclick: () => newChapter(audio.currentTime || 0) }, '+ ', t('atPlayerPosition'))),
      h('ol.items', {}, S.chapters.map(chapterRow))),
    h('section.box', {}, h('h2', {}, t('sectionsCount', { n: S.sections.length })),
      h('p.muted.small', {}, t('sectionsHint')),
      h('ol.items', {}, S.sections.map(sectionRow))),
    h('datalist', { id: 'alltags' }, S.allTags.map((x) => h('option', { value: x }))),
  ].filter(Boolean));
}

// ---------- Auto-cut panel ----------
const THRESHOLDS = ['off', 'certain', 'likely', 'all'];
const TYPES = ['hesitation', 'filler', 'pause'];

async function acAct(fn) {
  try { AC = await fn(); renderTranscript(); renderPanel(); }
  catch (e) { alert(e.message); }
}

function jobLine(job, kind) {
  if (!job || job.status === 'done') return null;
  const label = job.status === 'error' ? `${t('acJobError')}: ${job.error || ''}`
    : job.status === 'queued' ? t('acJobQueued') : `${t(kind === 'analyze' ? 'acMeasuring' : 'acCutting')} ${job.progress ? t('acProgress.' + job.progress) : ''}`;
  return h(`p.small${job.status === 'error' ? '.err' : ''}`, {}, label);
}

let acPoll = 0;
function pollJobs() {
  clearTimeout(acPoll);
  const running = ['analyze', 'autocut'].some((k) => ['queued', 'running'].includes(AC?.jobs?.[k]?.status));
  if (running) acPoll = setTimeout(async () => { AC = await api('GET', `/api/episodes/${epId}/autocut`).catch(() => AC); renderTranscript(); renderPanel(); }, 10000);
}

function autocutBox() {
  if (!AC || !S.transcript) return null;
  pollJobs();
  const s = AC.settings;
  const saveSettings = (next) => acAct(() => api('PUT', `/api/episodes/${epId}/autocut`, { settings: next }));
  const change = (fn) => () => { const next = structuredClone(s); fn(next); saveSettings(next); };
  const numIn = (key, label) => h('label.small', {}, label, ' ', h('input.num', { type: 'number', min: 0.1, max: 30, step: 0.1, value: s.pauses[key],
    disabled: !s.pauses.on, onchange: (e) => change((n) => { n.pauses[key] = Number(e.target.value); })() }), ' s');
  const thresholdSel = (key) => h('select', { 'aria-label': t('ac.' + key), onchange: (e) => change((n) => { n[key] = e.target.value; })() },
    THRESHOLDS.map((v) => h('option', { value: v, selected: s[key] === v }, t('acThreshold.' + v))));

  // Counts per type and group
  const count = (type, group) => AC.cuts.filter((c) => c.type === type && (!group || c.group === group)).length;
  const summary = AC.active ? h('table.actable', {},
    h('tr', {}, h('th', {}, ''), ...['certain', 'likely', 'unsure'].map((g) => h('th', {}, h('span', { class: `acdot ac-${g}` }), ' ', t(GROUP_LABEL[g])))),
    ...TYPES.map((type) => h('tr', {}, h('td', {}, t('acType.' + type)), ...['certain', 'likely', 'unsure'].map((g) => h('td', {}, count(type, g) || '–'))))) : null;
  const ownLine = AC.ownCount ? h('p.small', {}, h('span', { class: 'acdot ac-own' }), ' ', t('acOwnCount', { n: AC.ownCount })) : null;
  const marked = AC.cuts.filter((c) => c.marked).length;

  const filter = h('div.inline.small', { role: 'radiogroup', 'aria-label': t('acShow') }, t('acShow'), ' ',
    ...['all', 'certain', 'likely', 'unsure', 'none'].map((v) => h('label.check', {},
      h('input', { type: 'radio', name: 'acfilter', value: v, checked: acFilter === v, onchange: () => { acFilter = v; renderTranscript(); } }), ' ', t('acFilter.' + v))));

  const cut = AC.cut;
  const cutInfo = cut ? h('div', {},
    h('p', {}, t('acCutReady', { when: new Date(cut.createdAt.replace(' ', 'T') + 'Z').toLocaleString(), n: cut.count, seconds: Math.round(cut.removed || 0) })),
    AC.outdated ? h('p.warn', {}, t('acOutdated')) : null,
    h('audio', { controls: true, preload: 'none', src: `/media/audio/${cut.id}` }),
    h('div.inline', {},
      h('a.button.small', { href: `/media/download/${cut.id}?f=original` }, t('acDownloadFlac')),
      cut.hasMp3 ? h('a.button.small', { href: `/media/download/${cut.id}?f=mp3` }, t('acDownloadMp3')) : null,
      h('button.small.linkbtn.danger', { onclick: () => { if (confirm(t('acRemoveConfirm'))) acAct(() => api('DELETE', `/api/episodes/${epId}/autocut/cut`)); } }, t('acRemove')))) : null;

  return h('section.box.autocut', {},
    h('h2', {}, t('acHeading')),
    h('p.muted.small', {}, AC.ownSettings ? t('acOwnSettings') : t('acPodcastSettings'),
      AC.ownSettings ? [' ', h('button.small.linkbtn', { onclick: () => saveSettings(null) }, t('acUsePodcast'))] : null),
    h('fieldset', {}, h('legend', {}, t('ac.pauses')),
      h('label.check', {}, h('input', { type: 'checkbox', checked: s.pauses.on, onchange: (e) => change((n) => { n.pauses.on = e.target.checked; })() }), ' ', t('acShortenPauses')),
      h('div.inline', {}, numIn('longerThan', t('acLongerThan')), numIn('shortenTo', t('acShortenTo'))),
      h('div.inline', {}, numIn('turnLongerThan', t('acTurnLongerThan')), numIn('turnShortenTo', t('acShortenTo'))),
      s.pauses.on && !AC.measured ? h('p.small', {}, t('acNotMeasured'), ' ',
        h('button.small', { onclick: () => acAct(() => api('POST', `/api/episodes/${epId}/autocut/analyze`)) }, t('acMeasure'))) : null,
      jobLine(AC.jobs.analyze, 'analyze')),
    h('div.inline', {}, h('label', {}, t('ac.hesitations'), ' ', thresholdSel('hesitations'))),
    h('div.inline', {}, h('label', {}, t('ac.fillers'), ' ', thresholdSel('fillers'))),
    summary,
    ownLine,
    AC.active ? filter : null,
    AC.active ? h('p.small.muted', {}, t('acLegend')) : null,
    AC.active ? h('p.small.muted', {}, t('acHelp')) : null,
    AC.active ? h('div.inline', {},
      h('button.primary', { disabled: !AC.ranges.length, onclick: () => acAct(() => api('POST', `/api/episodes/${epId}/autocut/render`)) },
        t('acCutAll', { n: marked, seconds: Math.round(AC.removed) })),
      Object.values(AC.cuts).some((c) => c.manual) ? h('button.small.linkbtn', { onclick: () => { if (confirm(t('acResetConfirm'))) acAct(() => api('PUT', `/api/episodes/${epId}/autocut`, { resetOverrides: true })); } }, t('acReset')) : null) : null,
    jobLine(AC.jobs.autocut, 'autocut'),
    cutInfo);
}

load().catch((e) => { root.textContent = t('loadError', { message: e.message }); });
