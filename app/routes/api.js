import { Router } from 'express';
import { requireLogin } from '../lib/auth.js';
import { logChange, logFieldChanges } from '../lib/audit.js';
import { loadEpisode, httpError } from '../lib/episodes.js';
import { sanitizeWords, reindexTranscript, diffCount } from '../lib/transcript.js';
import { suggestChaptersAndTags, claudeAvailable } from '../lib/claude.js';
import { normalizeSettings } from '../lib/autocut.js';
import { autocutState } from '../lib/autocut-state.js';
import { currentAudio, currentCut } from '../lib/episodes.js';

// JSON API for the transcript editor (login required)
export default function apiRoutes(db) {
  const r = Router();
  r.use(requireLogin);
  r.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const ctx = (req, ep) => ({ user: req.user, podcastId: ep.podcast_id, episodeId: ep.id });

  const sectionsWithTags = (episodeId) => {
    const secs = db.all('SELECT * FROM sections WHERE episode_id = ? ORDER BY start', episodeId);
    const tags = db.all(`SELECT st.section_id, t.id, t.name FROM section_tags st JOIN tags t ON t.id = st.tag_id
                         JOIN sections s ON s.id = st.section_id WHERE s.episode_id = ? ORDER BY t.name`, episodeId);
    return secs.map((s) => ({ ...s, tags: tags.filter((t) => t.section_id === s.id).map((t) => t.name) }));
  };

  const state = (ep) => {
    const tr = db.get('SELECT * FROM transcripts WHERE episode_id = ?', ep.id);
    return {
      episode: { id: ep.id, title: ep.title, version: ep.version, speakerNames: JSON.parse(ep.speaker_names || '{}') },
      transcript: tr ? { words: JSON.parse(tr.words), version: tr.version, language: tr.language, updatedAt: tr.updated_at } : null,
      chapters: db.all('SELECT * FROM chapters WHERE episode_id = ? ORDER BY start', ep.id),
      sections: sectionsWithTags(ep.id),
      allTags: db.all('SELECT name FROM tags WHERE podcast_id = ? ORDER BY name COLLATE NOCASE', ep.podcast_id).map((t) => t.name),
      claude: claudeAvailable(),
    };
  };

  r.get('/episodes/:id/editor', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    res.json(state(ep));
  });

  // Save the transcript. Last save wins – with a notice on conflict.
  r.put('/episodes/:id/transcript', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const tr = db.get('SELECT * FROM transcripts WHERE episode_id = ?', ep.id);
    if (!tr) throw httpError(400, 'err.noTranscript');
    const words = sanitizeWords(req.body.words);
    const old = JSON.parse(tr.words);
    const conflict = Number(req.body.version) !== tr.version;
    let conflictBy = null;
    if (conflict) conflictBy = db.get('SELECT name FROM users WHERE id = ?', tr.updated_by)?.name;
    const n = diffCount(old, words);
    db.tx(() => {
      db.run(`UPDATE transcripts SET words = ?, version = version + 1, updated_at = datetime('now'), updated_by = ? WHERE episode_id = ?`, JSON.stringify(words), req.user.id, ep.id);
      reindexTranscript(db, ep.id, ep.podcast_id, words);
      if (n) logChange(db, { ...ctx(req, ep), type: 'transcript', id: ep.id, key: 'log.transcriptEdited', params: { n } });
      if (req.body.speakerNames && typeof req.body.speakerNames === 'object') {
        const names = Object.fromEntries(Object.entries(req.body.speakerNames).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 60)]));
        const before = ep.speaker_names;
        const after = JSON.stringify(names);
        if (before !== after) {
          db.run('UPDATE episodes SET speaker_names = ?, version = version + 1 WHERE id = ?', after, ep.id);
          logChange(db, { ...ctx(req, ep), type: 'episode', id: ep.id, field: 'speaker_names', oldValue: before, newValue: after, key: 'log.speakersNamed' });
        }
      }
    });
    const fresh = db.get('SELECT version FROM transcripts WHERE episode_id = ?', ep.id);
    res.json({ ok: true, version: fresh.version, conflict, conflictBy, changed: n });
  });

  // Claude suggestions for chapters and tagged sections
  r.post('/episodes/:id/suggestions', async (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const tr = db.get('SELECT words, language FROM transcripts WHERE episode_id = ?', ep.id);
    if (!tr) throw httpError(400, 'err.noTranscript');
    if (!claudeAvailable()) throw httpError(502, 'err.noClaudeKey');
    const podcast = db.get('SELECT * FROM podcasts WHERE id = ?', ep.podcast_id);
    const existingTags = db.all('SELECT name FROM tags WHERE podcast_id = ?', ep.podcast_id).map((t) => t.name);
    let result;
    try {
      result = await suggestChaptersAndTags({ podcast, episode: ep, words: JSON.parse(tr.words), speakerNames: JSON.parse(ep.speaker_names || '{}'), existingTags });
    } catch (e) { throw httpError(502, 'err.suggestionsFailed', { reason: e.message }); }
    db.tx(() => {
      // Replace older suggestions that were not accepted
      db.run(`DELETE FROM chapters WHERE episode_id = ? AND accepted = 0`, ep.id);
      db.run(`DELETE FROM sections WHERE episode_id = ? AND accepted = 0`, ep.id);
      for (const c of result.chapters) db.run(`INSERT INTO chapters (episode_id, start, title, summary, origin, accepted) VALUES (?,?,?,?, 'claude', 0)`, ep.id, c.start, c.title, c.summary);
      for (const s of result.sections) {
        const sid = Number(db.run(`INSERT INTO sections (episode_id, start, end, title, origin, accepted) VALUES (?,?,?,?, 'claude', 0)`, ep.id, s.start, s.end, s.title).lastInsertRowid);
        setSectionTags(ep, sid, s.tags, req, false);
      }
      logChange(db, { ...ctx(req, ep), type: 'suggestion', id: ep.id, key: 'log.suggestionsFetched', params: { chapters: result.chapters.length, sections: result.sections.length } });
    });
    res.json(state(ep));
  });

  // Set tags on a section; unknown tags are created for the podcast
  function setSectionTags(ep, sectionId, names, req, log = true) {
    const clean = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 10);
    db.run('DELETE FROM section_tags WHERE section_id = ?', sectionId);
    for (const name of clean) {
      let t = db.get('SELECT id FROM tags WHERE podcast_id = ? AND name = ? COLLATE NOCASE', ep.podcast_id, name);
      if (!t) {
        t = { id: Number(db.run('INSERT INTO tags (podcast_id, name) VALUES (?,?)', ep.podcast_id, name).lastInsertRowid) };
        if (log) logChange(db, { ...ctx(req, ep), type: 'tag', id: t.id, key: 'log.tagCreated', params: { tag: name } });
      }
      db.run('INSERT OR IGNORE INTO section_tags (section_id, tag_id) VALUES (?,?)', sectionId, t.id);
    }
    return clean;
  }

  const num = (v, field) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw httpError(400, 'err.invalidTime', { field }); return Math.round(n * 1000) / 1000; };

  // ----- Chapters -----
  r.post('/episodes/:id/chapters', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const title = String(req.body.title || '').trim() || req.t('editor.newChapter');
    const id = Number(db.run(`INSERT INTO chapters (episode_id, start, title, summary, origin, accepted) VALUES (?,?,?,?, 'redaktion', 1)`,
      ep.id, num(req.body.start, 'start'), title, String(req.body.summary || '').trim()).lastInsertRowid);
    logChange(db, { ...ctx(req, ep), type: 'chapter', id, key: 'log.chapterCreated', params: { title } });
    res.json(state(ep));
  });

  const ownChapter = (req, id) => {
    const c = db.get('SELECT * FROM chapters WHERE id = ?', Number(id));
    if (!c) throw httpError(404, 'err.chapterNotFound');
    return { c, ep: loadEpisode(db, req, c.episode_id) };
  };

  r.put('/chapters/:cid', (req, res) => {
    const { c, ep } = ownChapter(req, req.params.cid);
    const next = {
      start: req.body.start != null ? num(req.body.start, 'start') : c.start,
      title: req.body.title != null ? String(req.body.title).trim() || c.title : c.title,
      summary: req.body.summary != null ? String(req.body.summary).trim() : c.summary,
      accepted: req.body.accepted != null ? (req.body.accepted ? 1 : 0) : c.accepted,
    };
    db.tx(() => {
      if (next.accepted && !c.accepted) logChange(db, { ...ctx(req, ep), type: 'chapter', id: c.id, key: 'log.chapterAccepted', params: { title: next.title } });
      logFieldChanges(db, { ...ctx(req, ep), type: 'chapter', id: c.id }, c, next,
        { title: 'field.title', start: 'field.start', summary: 'field.summary' }, { key: 'log.chapterFieldChanged', params: { title: c.title } });
      db.run('UPDATE chapters SET start = ?, title = ?, summary = ?, accepted = ? WHERE id = ?', next.start, next.title, next.summary, next.accepted, c.id);
    });
    res.json(state(ep));
  });

  r.delete('/chapters/:cid', (req, res) => {
    const { c, ep } = ownChapter(req, req.params.cid);
    db.run('DELETE FROM chapters WHERE id = ?', c.id);
    logChange(db, { ...ctx(req, ep), type: 'chapter', id: c.id, key: c.accepted ? 'log.chapterDeleted' : 'log.chapterRejected', params: { title: c.title } });
    res.json(state(ep));
  });

  // ----- Sections -----
  r.post('/episodes/:id/sections', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const start = num(req.body.start, 'start'), end = num(req.body.end, 'end');
    if (end <= start) throw httpError(400, 'err.endBeforeStart');
    const title = String(req.body.title || '').trim();
    db.tx(() => {
      const id = Number(db.run(`INSERT INTO sections (episode_id, start, end, title, origin, accepted) VALUES (?,?,?,?, 'redaktion', 1)`, ep.id, start, end, title).lastInsertRowid);
      const tags = setSectionTags(ep, id, req.body.tags, req);
      logChange(db, { ...ctx(req, ep), type: 'section', id, key: 'log.sectionCreated', params: { title: title || '–', tags: tags.join(', ') || '–' } });
    });
    res.json(state(ep));
  });

  const ownSection = (req, id) => {
    const s = db.get('SELECT * FROM sections WHERE id = ?', Number(id));
    if (!s) throw httpError(404, 'err.sectionNotFound');
    return { s, ep: loadEpisode(db, req, s.episode_id) };
  };

  r.put('/sections/:sid', (req, res) => {
    const { s, ep } = ownSection(req, req.params.sid);
    const next = {
      start: req.body.start != null ? num(req.body.start, 'start') : s.start,
      end: req.body.end != null ? num(req.body.end, 'end') : s.end,
      title: req.body.title != null ? String(req.body.title).trim() : s.title,
      accepted: req.body.accepted != null ? (req.body.accepted ? 1 : 0) : s.accepted,
    };
    if (next.end <= next.start) throw httpError(400, 'err.endBeforeStart');
    const label = s.title || '–';
    db.tx(() => {
      if (next.accepted && !s.accepted) logChange(db, { ...ctx(req, ep), type: 'section', id: s.id, key: 'log.sectionAccepted', params: { title: label } });
      logFieldChanges(db, { ...ctx(req, ep), type: 'section', id: s.id }, s, next,
        { title: 'field.title', start: 'field.start', end: 'field.end' }, { key: 'log.sectionFieldChanged', params: { title: label } });
      db.run('UPDATE sections SET start = ?, end = ?, title = ?, accepted = ? WHERE id = ?', next.start, next.end, next.title, next.accepted, s.id);
      if (Array.isArray(req.body.tags)) {
        const before = sectionsWithTags(ep.id).find((x) => x.id === s.id)?.tags || [];
        const after = setSectionTags(ep, s.id, req.body.tags, req);
        if (before.join('|') !== after.join('|')) logChange(db, { ...ctx(req, ep), type: 'section', id: s.id, field: 'tags', oldValue: before.join(', '), newValue: after.join(', '), key: 'log.sectionTagsChanged', params: { title: label } });
      }
    });
    res.json(state(ep));
  });

  r.delete('/sections/:sid', (req, res) => {
    const { s, ep } = ownSection(req, req.params.sid);
    db.run('DELETE FROM sections WHERE id = ?', s.id);
    logChange(db, { ...ctx(req, ep), type: 'section', id: s.id, key: s.accepted ? 'log.sectionDeleted' : 'log.sectionRejected', params: { title: s.title || '–' } });
    res.json(state(ep));
  });

  // ----- Auto-cut -----
  const freshEpisode = (id) => db.get('SELECT * FROM episodes WHERE id = ?', id);

  r.get('/episodes/:id/autocut', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    res.json(autocutState(db, ep));
  });

  // Settings ({...} = own settings for this episode, null = use the podcast's) and/or
  // manual decisions ({ overrides: { id: true|false|null } }, null removes a decision)
  r.put('/episodes/:id/autocut', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    db.tx(() => {
      if ('settings' in req.body) {
        const before = ep.autocut_settings;
        const after = req.body.settings == null ? null : JSON.stringify(normalizeSettings(req.body.settings));
        if (before !== after) {
          db.run('UPDATE episodes SET autocut_settings = ? WHERE id = ?', after, ep.id);
          logChange(db, { ...ctx(req, ep), type: 'episode', id: ep.id, field: 'autocut_settings', oldValue: before, newValue: after,
            key: after == null ? 'log.autocutPodcastSettings' : 'log.autocutSettings' });
        }
      }
      if (req.body.overrides && typeof req.body.overrides === 'object') {
        const row = db.get('SELECT overrides FROM autocut WHERE episode_id = ?', ep.id);
        const cur = row ? JSON.parse(row.overrides) : {};
        for (const [id, v] of Object.entries(req.body.overrides).slice(0, 5000)) {
          const key = String(id).slice(0, 40);
          if (v == null) delete cur[key]; else cur[key] = Boolean(v);
        }
        db.run(`INSERT INTO autocut (episode_id, overrides, updated_at, updated_by) VALUES (?,?,datetime('now'),?)
                ON CONFLICT (episode_id) DO UPDATE SET overrides = excluded.overrides, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ep.id, JSON.stringify(cur), req.user.id);
      }
      if (req.body.resetOverrides) {
        db.run('DELETE FROM autocut WHERE episode_id = ?', ep.id);
        logChange(db, { ...ctx(req, ep), type: 'autocut', id: ep.id, key: 'log.autocutReset' });
      }
    });
    res.json(autocutState(db, freshEpisode(ep.id)));
  });

  // Measure the loudness of the pauses (for transcripts made before auto-cut existed)
  r.post('/episodes/:id/autocut/analyze', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const raw = currentAudio(db, ep.id, 'main');
    if (!raw) throw httpError(400, 'err.noMainAudio');
    if (!db.get('SELECT 1 FROM transcripts WHERE episode_id = ?', ep.id)) throw httpError(400, 'err.noTranscript');
    db.tx(() => {
      db.run(`UPDATE jobs SET status = 'error', error = 'replaced' WHERE episode_id = ? AND type = 'analyze' AND status = 'queued'`, ep.id);
      db.run(`INSERT INTO jobs (episode_id, audio_file_id, type, options) VALUES (?,?, 'analyze', '{}')`, ep.id, raw.id);
    });
    res.json(autocutState(db, ep));
  });

  // "Cut everything marked": the worker renders a new audio file from the original
  r.post('/episodes/:id/autocut/render', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const raw = currentAudio(db, ep.id, 'main');
    if (!raw) throw httpError(400, 'err.noMainAudio');
    const st = autocutState(db, ep);
    if (!st.ranges.length) throw httpError(400, 'err.nothingMarked');
    db.tx(() => {
      db.run(`UPDATE jobs SET status = 'error', error = 'replaced by a newer request' WHERE episode_id = ? AND type = 'autocut' AND status IN ('queued','running')`, ep.id);
      db.run(`INSERT INTO jobs (episode_id, audio_file_id, type, options) VALUES (?,?, 'autocut', ?)`, ep.id, raw.id,
        JSON.stringify({ ranges: st.ranges, transcriptVersion: st.transcriptVersion, settings: st.settings, userId: req.user.id }));
      logChange(db, { ...ctx(req, ep), type: 'autocut', id: ep.id, key: 'log.autocutRequested', params: { n: st.ranges.length, seconds: Math.round(st.removed) } });
    });
    res.json(autocutState(db, ep));
  });

  // Stop using the cut version (the original is played again; the file stays on disk)
  r.delete('/episodes/:id/autocut/cut', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const cut = currentCut(db, ep.id);
    if (cut) {
      db.run('UPDATE audio_files SET is_current = 0 WHERE id = ?', cut.id);
      logChange(db, { ...ctx(req, ep), type: 'audio', id: cut.id, key: 'log.autocutRemoved' });
    }
    res.json(autocutState(db, ep));
  });

  // Accept all open suggestions at once
  r.post('/episodes/:id/suggestions/accept-all', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    db.tx(() => {
      const a = db.run('UPDATE chapters SET accepted = 1 WHERE episode_id = ? AND accepted = 0', ep.id).changes;
      const b = db.run('UPDATE sections SET accepted = 1 WHERE episode_id = ? AND accepted = 0', ep.id).changes;
      logChange(db, { ...ctx(req, ep), type: 'suggestion', id: ep.id, key: 'log.suggestionsAccepted', params: { chapters: a, sections: b } });
    });
    res.json(state(ep));
  });

  return r;
}
