// Auto-cut report for tuning (phase 6 of docs/auto-cut-plan.md).
//
// Reads the database and shows, per episode, what auto-cut proposes and – most useful for tuning –
// where the team disagreed with the automatic decision. Read-only; nothing is changed.
//
//   node scripts/autocut-report.js                 all episodes with a transcript
//   node scripts/autocut-report.js --podcast slug  only one podcast
//   node scripts/autocut-report.js --episode 12    only one episode
//   node scripts/autocut-report.js --json          machine-readable output
//
// Uses DATA_DIR / DB_FILE like the app (run it with: node --env-file=../.env scripts/autocut-report.js).

import { openDb } from '../lib/db.js';
import { autocutState } from '../lib/autocut-state.js';
import { proposeCuts, normalizeSettings, GROUPS } from '../lib/autocut.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const asJson = args.includes('--json');

const db = openDb();
let sql = `SELECT e.*, p.slug AS podcast_slug FROM episodes e JOIN podcasts p ON p.id = e.podcast_id
  WHERE EXISTS (SELECT 1 FROM transcripts t WHERE t.episode_id = e.id)`;
const params = [];
if (opt('--podcast')) { sql += ' AND p.slug = ?'; params.push(opt('--podcast')); }
if (opt('--episode')) { sql += ' AND e.id = ?'; params.push(Number(opt('--episode'))); }
const episodes = db.all(sql + ' ORDER BY p.slug, e.id', ...params);

// Everything switched on at "all", to see every candidate regardless of the episode's settings
const EVERYTHING = normalizeSettings({ pauses: { on: true }, hesitations: 'all', fillers: 'all' });
const TYPES = ['hesitation', 'filler', 'pause'];
const sum = (cuts) => Math.round(cuts.reduce((s, c) => s + c.end - c.start, 0) * 10) / 10;

const report = episodes.map((ep) => {
  const tr = db.get('SELECT words, language, gaps, loudness FROM transcripts WHERE episode_id = ?', ep.id);
  const words = JSON.parse(tr.words);
  const gaps = tr.gaps ? JSON.parse(tr.gaps) : null;
  const minutes = words.length ? (words.at(-1).e - words[0].s) / 60 : 0;
  const all = proposeCuts(words, EVERYTHING, tr.language, gaps);
  const st = autocutState(db, ep);

  const byGroup = Object.fromEntries(TYPES.map((type) => [type, Object.fromEntries(GROUPS.map((g) => {
    const c = all.filter((x) => x.type === type && x.group === g);
    return [g, { n: c.length, seconds: sum(c) }];
  }))]));

  // Team decisions that differ from the automatic one, per type and group, with the most common reasons
  const disagreements = st.cuts.filter((c) => c.manual && c.marked !== c.on).map((c) => ({
    type: c.type, group: c.group, decision: c.marked ? 'cut' : 'keep', reasons: c.reasons, at: c.start,
    text: c.type === 'pause' ? null : words.filter((w) => w.s >= c.start - 0.001 && w.e <= c.end + 0.001).map((w) => w.w).join(' '),
  }));

  return {
    id: ep.id, podcast: ep.podcast_slug, title: ep.title, language: tr.language,
    minutes: Math.round(minutes * 10) / 10,
    words: words.length,
    hesitationsPerMinute: minutes ? Math.round((words.filter((w) => w.f).length / minutes) * 10) / 10 : 0,
    pausesMeasured: Boolean(gaps),
    quietShare: gaps?.length ? Math.round((gaps.filter((g) => g.quiet).length / gaps.length) * 100) : null,
    loudness: tr.loudness ? JSON.parse(tr.loudness) : null,
    candidates: byGroup,
    settings: st.settings,
    marked: { n: st.cuts.filter((c) => c.marked).length, seconds: st.removed },
    manualChanges: st.cuts.filter((c) => c.manual).length,
    disagreements,
    cutVersion: st.cut ? { removed: st.cut.removed, outdated: st.outdated } : null,
  };
});

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else if (!report.length) {
  console.log('No episodes with a transcript found.');
} else {
  for (const r of report) {
    console.log(`\n#${r.id} ${r.title} (${r.podcast}, ${r.language || '?'}) – ${r.minutes} min, ${r.words} words, ${r.hesitationsPerMinute} hesitation sounds/min`);
    console.log(`  Pauses measured: ${r.pausesMeasured ? `yes, ${r.quietShare}% quiet` : 'no'}${r.loudness ? ` (speech ${r.loudness.speechDb} dB, threshold ${r.loudness.thresholdDb} dB)` : ''}`);
    console.log('  Candidates (all settings on)   certain        likely         unsure');
    for (const type of TYPES) {
      const g = r.candidates[type];
      console.log(`    ${type.padEnd(28)}${GROUPS.slice().reverse().map((x) => `${String(g[x].n).padStart(4)} / ${String(g[x].seconds).padStart(5)} s`).join('  ')}`);
    }
    console.log(`  Marked with the episode's settings: ${r.marked.n} cuts, ${r.marked.seconds} s`);
    console.log(`  Manual changes: ${r.manualChanges}, of which the team disagreed with the proposal: ${r.disagreements.length}`);
    for (const d of r.disagreements.slice(0, 30)) {
      console.log(`    ${d.decision === 'keep' ? 'kept ' : 'cut  '} ${d.type.padEnd(10)} ${d.group.padEnd(7)} at ${d.at.toFixed(1)} s ${d.text ? `“${d.text}”` : ''}  (${d.reasons.join(', ')})`);
    }
    if (r.cutVersion) console.log(`  Cut version: ${r.cutVersion.removed} s removed${r.cutVersion.outdated ? ', OUTDATED' : ''}`);
  }
  // Summary across episodes: where do people disagree most?
  const all = report.flatMap((r) => r.disagreements);
  if (all.length) {
    console.log('\nDisagreements across all episodes (type / group / decision):');
    const counts = {};
    for (const d of all) { const k = `${d.type} / ${d.group} / ${d.decision}`; counts[k] = (counts[k] || 0) + 1; }
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log('\nWhat to do with this: see docs/auto-cut-tuning.md');
  }
}
db.close();
