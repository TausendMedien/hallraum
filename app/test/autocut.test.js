// Unit tests for the auto-cut proposals (lib/autocut.js) and the settings migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultSettings, normalizeSettings, resolveSettings, settingsFromLevel,
  proposeCuts, ownCut, selectedRanges, mergeRanges, makeTimeline,
} from '../lib/autocut.js';

// Builds words: each word lasts 0.3 s, with 0.1 s between words. "+1.5" inserts 1.5 s of extra pause.
// Parts are [speaker, text]; a new part with another speaker starts a new turn.
function talk(...parts) {
  const words = [];
  let t = 0;
  for (const [sp, text] of parts) {
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^\+(\d+(?:\.\d+)?)$/);
      if (m) { t += Number(m[1]); continue; }
      words.push({ w: tok, s: r(t), e: r(t + 0.3), sp });
      t += 0.4;
    }
  }
  return words;
}
const r = (n) => Math.round(n * 1000) / 1000;
const ALL = { pauses: { on: true }, hesitations: 'all', fillers: 'all' };
const words = (cuts, ws) => cuts.map((c) => ws.slice(c.from, c.to + 1).map((w) => w.w).join(' '));
const find = (cuts, ws, text) => cuts.find((c) => c.type !== 'pause' && ws.slice(c.from, c.to + 1).map((w) => w.w).join(' ') === text);

test('settings: defaults are all off, invalid values are ignored', () => {
  assert.deepEqual(normalizeSettings(null), defaultSettings());
  assert.deepEqual(normalizeSettings('not json'), defaultSettings());
  const s = normalizeSettings({ hesitations: 'likely', fillers: 'bogus', pauses: { on: 1, longerThan: '2', shortenTo: 5, turnLongerThan: -3 } });
  assert.equal(s.hesitations, 'likely');
  assert.equal(s.fillers, 'off');
  assert.equal(s.pauses.on, true);
  assert.equal(s.pauses.longerThan, 2);
  assert.equal(s.pauses.shortenTo, 2, 'a pause is never "shortened" to more than its limit');
  assert.equal(s.pauses.turnLongerThan, 0.1, 'values are kept in a sensible range');
});

test('settings: an episode overrides the podcast key by key', () => {
  const podcast = JSON.stringify({ pauses: { on: true, longerThan: 1.5 }, hesitations: 'certain', fillers: 'likely' });
  assert.equal(resolveSettings(podcast, null).fillers, 'likely');
  const s = resolveSettings(podcast, JSON.stringify({ fillers: 'off', pauses: { shortenTo: 0.5 } }));
  assert.equal(s.fillers, 'off');
  assert.equal(s.hesitations, 'certain');
  assert.equal(s.pauses.on, true);
  assert.equal(s.pauses.longerThan, 1.5);
  assert.equal(s.pauses.shortenTo, 0.5);
});

test('settings: old levels are converted, including German names', () => {
  assert.equal(settingsFromLevel('off'), null);
  assert.equal(settingsFromLevel('unknown'), null);
  assert.deepEqual(settingsFromLevel('mittel'), settingsFromLevel('medium'));
  const strong = settingsFromLevel('strong');
  assert.equal(strong.pauses.on, true);
  assert.equal(strong.hesitations, 'all');
  assert.equal(strong.fillers, 'likely');
});

test('nothing is proposed when everything is off', () => {
  const ws = talk(['A', 'Also, das ist äh +2 gut.']);
  assert.deepEqual(proposeCuts(ws, defaultSettings(), 'de'), []);
});

test('hesitation sounds depend on the language: German "um" is a real word', () => {
  const de = talk(['A', 'Ich gehe raus, um äh frische Luft zu holen.']);
  assert.deepEqual(words(proposeCuts(de, ALL, 'de'), de), ['äh']);
  const en = talk(['A', 'I went um outside.']);
  const cuts = proposeCuts(en, ALL, 'en');
  assert.deepEqual(words(cuts, en), ['um']);
  assert.equal(cuts[0].group, 'certain');
  assert.equal(cuts[0].type, 'hesitation');
});

test('hesitation sounds lose certainty for low confidence, odd length or no gap', () => {
  const ws = talk(['A', 'Das ist äh gut und ähm schön und äh fein.']);
  ws[2].c = 0.3;                               // first "äh": Whisper is unsure → likely
  ws[5].e = r(ws[5].s + 0.05);                 // "ähm": only 50 ms long → likely
  ws[8].c = 0.3; ws[8].s = ws[7].e;            // last "äh": unsure and directly against "und" → unsure
  const cuts = proposeCuts(ws, ALL, 'de');
  assert.deepEqual(cuts.map((c) => c.group), ['likely', 'likely', 'unsure']);
  assert.deepEqual(cuts[2].reasons, ['hesitation', 'lowConfidence', 'tight']);
});

test('cutting a word leaves a natural gap and does not touch the neighbours', () => {
  const ws = talk(['A', 'Das äh +0.5 ist gut.']);  // "Das"[0–0.3] gap 0.1 "äh"[0.4–0.7] gap 0.6 "ist"[1.3–1.6]
  const [c] = proposeCuts(ws, ALL, 'de');
  assert.ok(c.start >= ws[0].e && c.end <= ws[2].s, 'the cut stays between the neighbouring words');
  const left = (c.start - ws[0].e) + (ws[2].s - c.end);
  assert.equal(r(left), 0.4, 'the larger gap is kept, at most 0.4 s');
});

test('filler words: signs move them up from "unsure"', () => {
  const ws = talk(
    ['A', 'Also, das war gut. Das ist, quasi, normal. Das ist halt halt so. Das war irgendwie schön.'],
  );
  const cuts = proposeCuts(ws, ALL, 'de');
  assert.equal(find(cuts, ws, 'Also,').group, 'likely', 'sentence start followed by a comma');
  assert.equal(find(cuts, ws, 'quasi,').group, 'likely', 'set off by commas');
  assert.equal(find(cuts, ws, 'halt').group, 'likely', 'repeated');
  assert.equal(find(cuts, ws, 'irgendwie').group, 'unsure', 'no signs');
});

test('filler words next to a hesitation sound are more certain', () => {
  const ws = talk(['A', 'Das ist, also, äh schwierig.']);
  const cuts = proposeCuts(ws, ALL, 'de');
  assert.equal(find(cuts, ws, 'also,').group, 'certain', 'set off by commas and next to "äh"');
});

test('filler words that are answers or real words are not proposed', () => {
  const de = talk(['A', 'War das gut?'], ['B', 'Ja.'], ['A', 'Und dann?'], ['B', 'Genau das wollte ich sagen.'], ['A', 'Ja, klar.']);
  assert.deepEqual(words(proposeCuts(de, ALL, 'de'), de), []);
  const en = talk(['A', 'I like pizza and I would like to go. It is kind of a car. You know what?']);
  assert.deepEqual(words(proposeCuts(en, ALL, 'en'), en), []);
});

test('English phrases are cut as a whole', () => {
  const ws = talk(['A', 'It was, like, huge. You know, it was big.']);
  const cuts = proposeCuts(ws, ALL, 'en');
  assert.deepEqual(words(cuts, ws), ['like,', 'You know,']);
  assert.equal(find(cuts, ws, 'You know,').group, 'likely');
});

test('the threshold decides what is marked, but everything is listed', () => {
  const ws = talk(['A', 'Das ist, quasi, normal und irgendwie schön.']);
  const cuts = proposeCuts(ws, { fillers: 'certain' }, 'de');
  assert.equal(cuts.length, 2);
  assert.ok(cuts.every((c) => !c.on), 'likely and unsure fillers are listed but not marked');
  const likely = proposeCuts(ws, { fillers: 'likely' }, 'de');
  assert.deepEqual(likely.map((c) => c.on), [true, false]);
});

test('pauses: shortened to the set length, more generous at a change of speaker', () => {
  const ws = talk(['A', 'Eins +2 zwei'], ['B', '+1.5 drei']);
  const cuts = proposeCuts(ws, { pauses: { on: true } }, 'de');
  assert.equal(cuts.length, 1, 'the 1.6 s pause at the change of speaker stays (limit 2 s)');
  const [c] = cuts;
  assert.equal(c.type, 'pause');
  assert.equal(r(ws[1].s - ws[0].e - (c.end - c.start)), 0.7, 'what is left is 0.7 s');
  assert.equal(c.group, 'likely', 'not measured yet');
  assert.equal(c.on, true);
});

test('pauses: measured loudness decides the group', () => {
  const ws = talk(['A', 'Eins +2 zwei +2 drei +6 vier']);
  const gaps = [
    { start: ws[0].e, end: ws[1].s, quiet: true },
    { start: ws[1].e, end: ws[2].s, quiet: false }, // music or laughter
    { start: ws[2].e, end: ws[3].s, quiet: true },
  ];
  const cuts = proposeCuts(ws, { pauses: { on: true } }, 'de', gaps);
  assert.deepEqual(cuts.map((c) => c.group), ['certain', 'unsure', 'unsure']);
  assert.deepEqual(cuts.map((c) => c.on), [true, false, false]);
  assert.ok(cuts[2].reasons.includes('veryLong'));
});

test('manual changes override the proposal; ranges are merged', () => {
  const ws = talk(['A', 'Das ist, also, äh schwierig und irgendwie gut.']);
  const cuts = proposeCuts(ws, ALL, 'de');
  const vague = find(cuts, ws, 'irgendwie');
  const also = find(cuts, ws, 'also,');
  const ranges = selectedRanges(cuts, { [vague.id]: false, [also.id]: true });
  assert.equal(ranges.length, 1, '"also," and "äh" are next to each other and become one cut');
  assert.deepEqual(mergeRanges([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 1.5, end: 3 }, { start: 4, end: 4 }]),
    [{ start: 1, end: 3 }, { start: 5, end: 6 }]);
});

test('timeline: times are translated between original and cut version', () => {
  const tl = makeTimeline([{ start: 5, end: 5.5 }, { start: 1, end: 2 }]);
  assert.equal(tl.removed, 1.5);
  assert.equal(tl.toCut(0.5), 0.5);
  assert.equal(tl.toCut(1.5), 1, 'a time inside a cut maps to where playback continues');
  assert.equal(tl.toCut(3), 2);
  assert.equal(tl.toCut(6), 4.5);
  assert.equal(tl.toOriginal(2), 3);
  assert.equal(tl.toOriginal(4.5), 6);
  for (const t of [0, 0.9, 2, 3.7, 4.99, 5.5, 10]) assert.equal(tl.toOriginal(tl.toCut(t)), t, `round trip for ${t}`);
});

test('migration: the old auto-cut level becomes the new settings', async () => {
  const { openDb } = await import('../lib/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallraum-migrate-'));
  const file = path.join(dir, 'app.sqlite');
  try {
    // Simulate a database from before the change
    let db = openDb(file);
    db.exec(`ALTER TABLE podcasts DROP COLUMN autocut_settings; ALTER TABLE podcasts ADD COLUMN autocut_default TEXT NOT NULL DEFAULT 'off';
             ALTER TABLE episodes DROP COLUMN autocut_settings; ALTER TABLE episodes ADD COLUMN autocut_level TEXT;`);
    const p1 = Number(db.run(`INSERT INTO podcasts (name, slug, autocut_default) VALUES ('One','one','sanft')`).lastInsertRowid);
    const p2 = Number(db.run(`INSERT INTO podcasts (name, slug) VALUES ('Two','two')`).lastInsertRowid);
    const e1 = Number(db.run(`INSERT INTO episodes (podcast_id, slug, title, autocut_level) VALUES (?, 'e', 'E', 'strong')`, p2).lastInsertRowid);
    db.close();

    db = openDb(file);
    const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    assert.ok(!cols('podcasts').includes('autocut_default'));
    assert.ok(!cols('episodes').includes('autocut_level'));
    assert.deepEqual(JSON.parse(db.get('SELECT autocut_settings AS s FROM podcasts WHERE id = ?', p1).s), settingsFromLevel('soft'));
    assert.equal(db.get('SELECT autocut_settings AS s FROM podcasts WHERE id = ?', p2).s, '{}');
    assert.deepEqual(JSON.parse(db.get('SELECT autocut_settings AS s FROM episodes WHERE id = ?', e1).s), settingsFromLevel('strong'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('own cuts: any words, widened into the silence around them like a proposal', () => {
  const ws = talk(['A', 'Das ist wirklich sehr gut']);
  const c = ownCut(ws, ws[2].s, ws[3].e); // "wirklich sehr"
  assert.equal(c.type, 'own');
  assert.equal(c.marked, undefined);
  assert.equal(c.on, true);
  assert.deepEqual([c.from, c.to], [2, 3]);
  assert.ok(c.start < ws[2].s && c.start > ws[1].e, 'starts in the gap before');
  assert.ok(c.end > ws[3].e && c.end < ws[4].s, 'ends in the gap after');
  assert.equal(ownCut(ws, 50, 51), null, 'no words in the range (transcript changed)');
});
