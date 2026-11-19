// End-to-end tests against a fresh database in a temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hallraum-test-'));
process.env.DATA_DIR = tmp;
process.env.WORKER_TOKEN = 'test-worker-token-1234567890';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEFAULT_LOCALE;

const { openDb } = await import('../lib/db.js');
const { hashPassword } = await import('../lib/auth.js');
const { createApp } = await import('../server.js');
const { computeChecklist } = await import('../lib/checklist.js');
const { ftsQuery } = await import('../routes/public.js');

let server, base, db;
const W = { authorization: 'Bearer test-worker-token-1234567890', 'content-type': 'application/json' };
const EN = { 'accept-language': 'en-US,en;q=0.9' };

before(async () => {
  db = openDb(path.join(tmp, 'app.sqlite'));
  const anna = Number(db.run(`INSERT INTO users (name, email, pw_hash, is_superadmin, locale) VALUES ('Anna','anna@x.org',?,1,'en')`, hashPassword('password1234')).lastInsertRowid);
  const ben = Number(db.run(`INSERT INTO users (name, email, pw_hash, locale) VALUES ('Ben','ben@x.org',?,'en')`, hashPassword('password1234')).lastInsertRowid);
  const otto = Number(db.run(`INSERT INTO users (name, email, pw_hash) VALUES ('Otto','otto@x.org',?)`, hashPassword('password1234')).lastInsertRowid);
  const p1 = Number(db.run(`INSERT INTO podcasts (name, slug, language, content_warning_options) VALUES ('Sample Show','sample-show','en','["Violence"]')`).lastInsertRowid);
  const p2 = Number(db.run(`INSERT INTO podcasts (name, slug, language) VALUES ('Hörprobe','hoerprobe','de')`).lastInsertRowid);
  db.run(`INSERT INTO memberships VALUES (?,?, 'admin'), (?,?, 'editor'), (?,?, 'admin')`, anna, p1, ben, p1, otto, p2);
  db.run(`INSERT INTO seasons (podcast_id, number) VALUES (?,1)`, p1);
  server = createApp(db).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function login(email, headers = EN) {
  const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ email, password: 'password1234' }) });
  assert.equal(r.status, 302);
  return r.headers.get('set-cookie').split(';')[0];
}
const form = (cookie, url, data) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie }, body: new URLSearchParams(data) });
const json = (cookie, method, url, data) => fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
const page = async (cookie, url, headers = {}) => (await fetch(base + url, { headers: { cookie, ...headers } })).text();

// Tiny WAV file (1 s of silence) without ffmpeg
function wav() {
  const rate = 8000, n = rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

let annaCookie, benCookie, ottoCookie, epId;

test('login and access control', async () => {
  const bad = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: EN, body: new URLSearchParams({ email: 'anna@x.org', password: 'wrong' }) });
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /Email or password is incorrect/);
  annaCookie = await login('anna@x.org');
  benCookie = await login('ben@x.org');
  ottoCookie = await login('otto@x.org', { 'accept-language': 'de-DE,de;q=0.9' });
  assert.match(await page(benCookie, '/admin'), /Sample Show: Episodes/);
  assert.equal((await fetch(base + '/admin', { redirect: 'manual' })).status, 302);
});

test('UI language: browser language, then personal choice', async () => {
  // Otto has no saved language: German browser -> German interface
  assert.match(await page(ottoCookie, '/admin', { 'accept-language': 'de-DE' }), /Hörprobe: Folgen/);
  // Saving a language overrides the browser
  await form(ottoCookie, '/admin/language', { locale: 'en' });
  assert.match(await page(ottoCookie, '/admin', { 'accept-language': 'de-DE' }), /Hörprobe: Episodes/);
  await form(ottoCookie, '/admin/language', { locale: 'de' });
  assert.match(await page(ottoCookie, '/admin'), /Hörprobe: Folgen/);
  // Unknown values are ignored
  await form(ottoCookie, '/admin/language', { locale: 'xx' });
  assert.equal(db.get(`SELECT locale FROM users WHERE email = 'otto@x.org'`).locale, 'de');
});

test('create episode, upload audio, job is queued', async () => {
  const r = await form(benCookie, '/admin/episodes', { title: 'Media in Everyday Life with Mira', guest: 'Mira', number: '1' });
  assert.equal(r.status, 302);
  epId = Number(r.headers.get('location').split('/').pop());
  const fd = new FormData();
  fd.append('kind', 'main');
  fd.append('file', new Blob([wav()], { type: 'audio/wav' }), 'mira.wav');
  const up = await fetch(`${base}/admin/episodes/${epId}/audio`, { method: 'POST', headers: { cookie: benCookie }, body: fd, redirect: 'manual' });
  assert.equal(up.status, 302);
  assert.equal(db.get('SELECT status FROM jobs WHERE episode_id = ?', epId).status, 'queued');
  assert.match(await page(benCookie, `/admin/episodes/${epId}`), /waiting for transcription worker/);
});

test('wrong file type gives a translated error', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['x']), 'notes.txt');
  const r = await fetch(`${base}/admin/episodes/${epId}/audio`, { method: 'POST', headers: { cookie: benCookie, 'x-requested-with': 'fetch' }, body: fd });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /File type \.txt is not allowed/);
});

test('podcasts are separated', async () => {
  assert.equal((await fetch(`${base}/admin/episodes/${epId}`, { headers: { cookie: ottoCookie } })).status, 404);
  assert.equal((await json(ottoCookie, 'GET', `/api/episodes/${epId}/editor`)).status, 404);
  const a = db.get('SELECT id FROM audio_files WHERE episode_id = ?', epId);
  assert.equal((await fetch(`${base}/media/audio/${a.id}`, { headers: { cookie: ottoCookie } })).status, 403);
  assert.equal((await fetch(`${base}/media/audio/${a.id}`)).status, 403);
  const priv = await fetch(`${base}/media/audio/${a.id}`, { headers: { cookie: benCookie } });
  assert.equal(priv.status, 200);
  assert.equal(priv.headers.get('cache-control'), 'private, no-store'); // unpublished audio is never cached
});

test('worker: rejected without token, job + result with token', async () => {
  assert.equal((await fetch(base + '/api/worker/next', { method: 'POST' })).status, 401);
  const next = await (await fetch(base + '/api/worker/next', { method: 'POST', headers: W, body: JSON.stringify({ info: 'test' }) })).json();
  assert.equal(next.job.episodeId, epId);
  assert.equal((await fetch(base + next.job.audio.url, { headers: W })).status, 200);
  assert.equal(db.get('SELECT status FROM jobs WHERE id = ?', next.job.id).status, 'running');
  // Progress codes are translated in the admin
  await fetch(`${base}/api/worker/jobs/${next.job.id}/progress`, { method: 'POST', headers: W, body: JSON.stringify({ progress: 'aligning' }) });
  assert.match(await page(benCookie, '/admin'), /transcribing … aligning words/);
  const words = [
    { w: 'Hello', s: 0, e: 0.4, sp: 'SPEAKER_00' }, { w: 'um,', s: 0.5, e: 0.7, sp: 'SPEAKER_00' }, { w: 'Mira.', s: 0.8, e: 1.2, sp: 'SPEAKER_00' },
    { w: 'Media', s: 3, e: 3.5, sp: 'SPEAKER_01' }, { w: 'literacy', s: null, e: null, sp: 'SPEAKER_01' }, { w: 'matters.', s: 4, e: 4.5, sp: 'SPEAKER_01' },
  ];
  const res = await fetch(`${base}/api/worker/jobs/${next.job.id}/result`, { method: 'POST', headers: W, body: JSON.stringify({ language: 'en', words, duration: 5 }) });
  assert.equal(res.status, 200);
  const tr = JSON.parse(db.get('SELECT words FROM transcripts WHERE episode_id = ?', epId).words);
  assert.equal(tr[1].f, 1, 'English "um" is a filler');
  assert.ok(tr[4].s >= 3.5 && tr[4].e <= 4, 'missing time interpolated');
  assert.equal(db.get('SELECT status FROM jobs WHERE id = ?', next.job.id).status, 'done');
  assert.equal((await (await fetch(base + '/api/worker/next', { method: 'POST', headers: W, body: '{}' })).json()).job, null);
});

test('filler words depend on the spoken language', async () => {
  const { isFiller, isSoftFiller } = await import('../lib/languages.js');
  assert.equal(isFiller('um', 'en'), true);
  assert.equal(isFiller('um', 'de'), false, 'German "um" (um … zu) is a real word');
  assert.equal(isFiller('Ähm,', 'de'), true);
  assert.equal(isFiller('äh', 'de'), true);
  assert.equal(isFiller('äh', 'en'), false);
  assert.equal(isSoftFiller('halt', 'de'), true);
  assert.equal(isSoftFiller('like', 'en'), true);
});

test('edit transcript with conflict notice and change log', async () => {
  const st = await (await json(annaCookie, 'GET', `/api/episodes/${epId}/editor`)).json();
  const words = st.transcript.words.map((w) => ({ ...w }));
  words[2].w = 'Mira!';
  const r1 = await (await json(annaCookie, 'PUT', `/api/episodes/${epId}/transcript`, { words, version: st.transcript.version, speakerNames: { SPEAKER_00: 'Anna', SPEAKER_01: 'Mira' } })).json();
  assert.equal(r1.conflict, false);
  assert.equal(r1.changed, 1);
  // Ben saves with the old version -> wins, but gets a notice
  const r2 = await (await json(benCookie, 'PUT', `/api/episodes/${epId}/transcript`, { words, version: st.transcript.version })).json();
  assert.equal(r2.conflict, true);
  assert.equal(r2.conflictBy, 'Anna');
  // The change log is stored language-neutral and shown in the user's language
  assert.match(await page(benCookie, `/admin/episodes/${epId}`), /Transcript edited \(1 words changed\)/);
  db.run(`UPDATE users SET locale = 'de' WHERE email = 'ben@x.org'`);
  assert.match(await page(benCookie, `/admin/episodes/${epId}`), /Transkript bearbeitet \(1 Wörter geändert\)/);
  db.run(`UPDATE users SET locale = 'en' WHERE email = 'ben@x.org'`);
});

test('chapters, sections, tags and merging', async () => {
  await json(benCookie, 'POST', `/api/episodes/${epId}/chapters`, { start: 0, title: 'Welcome' });
  let st = await (await json(benCookie, 'POST', `/api/episodes/${epId}/sections`, { start: 3, end: 4.5, title: 'Why media literacy', tags: ['Media literacy', 'Education'] })).json();
  assert.equal(st.chapters.length, 1);
  assert.deepEqual(st.sections[0].tags.sort(), ['Education', 'Media literacy']);
  st = await (await json(benCookie, 'PUT', `/api/sections/${st.sections[0].id}`, { tags: ['Media literacy', 'Medienkompetenz'] })).json();
  assert.deepEqual(st.sections[0].tags.sort(), ['Media literacy', 'Medienkompetenz']);
  const from = db.get(`SELECT id FROM tags WHERE name = 'Medienkompetenz'`).id, into = db.get(`SELECT id FROM tags WHERE name = 'Media literacy'`).id;
  assert.equal((await form(annaCookie, '/admin/tags/merge', { from, into })).status, 302);
  st = await (await json(benCookie, 'GET', `/api/episodes/${epId}/editor`)).json();
  assert.deepEqual(st.sections[0].tags, ['Media literacy']);
  assert.equal((await json(ottoCookie, 'PUT', `/api/chapters/${st.chapters[0].id}`, { title: 'x' })).status, 404);
  const bad = await json(benCookie, 'POST', `/api/episodes/${epId}/sections`, { start: 5, end: 2 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /end must be after the start/);
});

test('Claude suggestions without a key give a clear error', async () => {
  const r = await json(annaCookie, 'POST', `/api/episodes/${epId}/suggestions`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /API key/);
});

test('checklist: automatic and manual steps', async () => {
  let cl = computeChecklist(db, db.get('SELECT * FROM episodes WHERE id = ?', epId));
  assert.ok(cl.items.find((i) => i.key === 'audio').done);
  assert.ok(cl.items.find((i) => i.key === 'transcript').done);
  assert.ok(!cl.items.find((i) => i.key === 'guest_share'), 'guest preview only when enabled');
  await form(benCookie, `/admin/episodes/${epId}/checklist`, { step: 'sound' });
  cl = computeChecklist(db, db.get('SELECT * FROM episodes WHERE id = ?', epId));
  const sound = cl.items.find((i) => i.key === 'sound');
  assert.ok(sound.done);
  assert.equal(sound.doneBy, 'Ben');
});

test('publish: episode page, search, topic playlist', async () => {
  const url = '/sample-show/1-media-in-everyday-life-with-mira';
  assert.equal((await fetch(base + url)).status, 404, 'drafts are not public');
  await form(annaCookie, `/admin/episodes/${epId}/publish`, { action: 'now' });
  const res = await fetch(base + url);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Welcome/);
  assert.match(body, /data-s="3"[^>]*>Media</);
  assert.match(body, /<html lang="en">/);
  const a = db.get('SELECT id FROM audio_files WHERE episode_id = ?', epId);
  const pub = await fetch(`${base}/media/audio/${a.id}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(pub.status, 206);
  assert.equal(pub.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await page('', '/sample-show/search?q=liter'), /<mark>literacy<\/mark>/);
  const topic = await fetch(`${base}/sample-show/topic/Media%20literacy`);
  assert.equal(topic.status, 200);
  assert.match(await topic.text(), /Why media literacy/);
  assert.match(await page('', '/hoerprobe/search?q=media'), /data-hits="0"/, 'other podcasts find nothing');
});

test('public pages follow the podcast language', async () => {
  const body = await page('', '/hoerprobe', { 'accept-language': 'en' });
  assert.match(body, /<html lang="de">/);
  assert.match(body, /Die erste Folge erscheint bald/);
});

test('every translation key exists in English and German', async () => {
  const { default: en } = await import('../locales/en.js');
  const { default: de } = await import('../locales/de.js');
  assert.deepEqual(Object.keys(de).filter((k) => !(k in en)), [], 'keys only in German');
  assert.deepEqual(Object.keys(en).filter((k) => !(k in de)), [], 'keys missing in German');
  // Keys used in the code must exist in en.js
  const used = new Set();
  const scan = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) scan(p); else if (f.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\b(?:t|httpError\(\d+,)\s*\(?'((?:nav|common|time|status|role|login|invite|podcast|overview|season|worker|job|progress|field|episode|msg|check|tags|settings|pattern|autocut|team|log|audio|err|pub)\.[\w.-]+)'/g)) used.add(m[1]); } };
  scan(path.join(import.meta.dirname, '..', 'routes'));
  scan(path.join(import.meta.dirname, '..', 'lib'));
  assert.deepEqual([...used].filter((k) => !(k in en)), [], 'keys used but not defined');
});

test('FTS query is safe against special characters', () => {
  assert.equal(ftsQuery('Lit"eracy OR *'), '"lit"* "eracy"* "or"*');
  assert.equal(ftsQuery('   '), '');
});
