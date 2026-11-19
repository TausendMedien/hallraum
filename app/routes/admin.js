import { Router } from 'express';
import path from 'node:path';
import { html, raw, fmtTime, slugify, RESERVED_SLUGS } from '../lib/html.js';
import { adminPage, flash } from '../lib/layout.js';
import { requireLogin, isPodcastAdmin, randomToken } from '../lib/auth.js';
import { logChange, logFieldChanges, episodeHistory, lastChange, renderSummary } from '../lib/audit.js';
import { computeChecklist, STEPS } from '../lib/checklist.js';
import { DATA_DIR } from '../lib/db.js';
import { findFfmpeg } from '../lib/audio.js';
import { loadEpisode, currentAudio, saveAudioUpload, saveImageUpload, jobStatus, httpError } from '../lib/episodes.js';
import { claudeAvailable } from '../lib/claude.js';
import { relTime, isLocale, clientStrings } from '../lib/i18n.js';
import { LANGUAGES } from '../lib/languages.js';

// Field name -> label key (used in the change log)
const EPISODE_LABELS = { title: 'field.title', description: 'field.description', guest: 'field.guest', number: 'field.number', season_id: 'field.season',
  slug: 'field.slug', explicit: 'field.explicit', content_warnings: 'field.contentWarnings', consent_date: 'field.consentDate',
  consent_note: 'field.consentNote', guest_share_enabled: 'field.guestShare', publish_at: 'field.publishAt' };

const PODCAST_LABELS = { name: 'field.name', slug: 'field.slug', subtitle: 'field.subtitle', description: 'field.description', author: 'field.author',
  owner_email: 'field.ownerEmail', language: 'field.language', category: 'field.category', explicit: 'field.explicit', theme: 'field.theme',
  content_warning_options: 'field.warningOptions', autocut_default: 'field.autocut' };

const AUTOCUT_LEVELS = ['off', 'soft', 'medium', 'strong'];

// Settings for planned features (guest preview, auto-cut) stay hidden until those features exist
const SHOW_PLANNED = false;

export default function adminRoutes(db) {
  const r = Router();
  r.use(requireLogin);
  r.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    req.rel = (d) => relTime(req.t.locale, d);
    next();
  });

  const heartbeatText = (req, hb) => {
    const t = req.t;
    if (!hb) return t('worker.never');
    const ageMin = (Date.now() - new Date(hb.at)) / 60000;
    return `${t('worker.lastSeen', { when: req.rel(hb.at) })} ${ageMin > 5 ? t('worker.offline') : t('worker.online')}${hb.info ? ' · ' + hb.info : ''}`;
  };

  const needPodcast = (req, res) => {
    if (req.podcast) return false;
    const t = req.t;
    res.send(adminPage(req, t('podcast.none'), html`<h1>${t('podcast.none')}</h1>
      ${req.user.isSuperadmin ? html`<p><a class="button primary" href="/admin/podcasts/new">${t('podcast.createFirst')}</a></p>` : html`<p>${t('podcast.noMembership')}</p>`}`));
    return true;
  };
  const podcastRow = (req) => db.get('SELECT * FROM podcasts WHERE id = ?', req.podcast.id);
  const ctx = (req, ep) => ({ user: req.user, podcastId: ep?.podcast_id ?? req.podcast?.id, episodeId: ep?.id });

  // ---------- UI language ----------
  r.post('/language', (req, res) => {
    if (isLocale(req.body.locale)) db.run('UPDATE users SET locale = ? WHERE id = ?', req.body.locale, req.user.id);
    let back = '/admin';
    try { const u = new URL(req.get('referer')); if (u.host === req.get('host')) back = u.pathname + u.search; } catch {}
    res.redirect(back);
  });

  // ---------- Overview ----------
  r.get('/', (req, res) => {
    if (needPodcast(req, res)) return;
    const t = req.t;
    const seasons = db.all('SELECT * FROM seasons WHERE podcast_id = ? ORDER BY number', req.podcast.id);
    const eps = db.all('SELECT * FROM episodes WHERE podcast_id = ? ORDER BY number IS NULL, number, id', req.podcast.id);
    const groups = [...seasons.map((s) => ({ s, eps: eps.filter((e) => e.season_id === s.id) })), { s: null, eps: eps.filter((e) => !e.season_id) }]
      .filter((g) => g.s || g.eps.length);
    const { heartbeat } = jobStatus(db, 0);
    const row = (e) => {
      const cl = computeChecklist(db, e);
      const js = jobStatus(db, e.id, t);
      const lc = lastChange(db, e.id);
      return html`<li class="eprow">
        <a href="/admin/episodes/${e.id}"><strong>${e.number != null ? `#${e.number} ` : ''}${e.title}</strong></a>
        ${e.status === 'published' ? html`<span class="badge ok">${t('status.published')}</span>` : html`<span class="badge">${t('status.draft')}</span>`}
        ${js.job && js.job.status !== 'done' ? html`<span class="badge ${js.job.status === 'error' ? 'err' : 'wait'}">${js.label}</span>` : ''}
        <div class="progress" role="progressbar" aria-valuenow="${cl.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${t('overview.progress')}"><span style="width:${cl.percent}%"></span></div>
        <small>${cl.done}/${cl.total} · ${t('overview.nextStep')}: ${t(cl.nextKey)}${lc ? html` · ${t('common.lastChangedBy', { name: lc.user_name || t('common.system'), when: req.rel(lc.at) })}` : ''}</small>
      </li>`;
    };
    res.send(adminPage(req, t('nav.episodes'), html`
      <div class="titlerow"><h1>${t('overview.title', { podcast: req.podcast.name })}</h1>
        <a class="button primary" href="/admin/episodes/new">+ ${t('overview.newEpisode')}</a></div>
      <p class="muted">${heartbeatText(req, heartbeat)}</p>
      ${groups.length ? groups.map((g) => html`<section class="season">
        <h2>${g.s ? `${t('season.label', { n: g.s.number })}${g.s.title ? ': ' + g.s.title : ''}` : t('season.none')}</h2>
        ${g.eps.length ? html`<ul class="eplist">${g.eps.map(row)}</ul>` : html`<p class="muted">${t('overview.noEpisodes')}</p>`}
      </section>`) : html`<p>${t('overview.empty')}</p>`}
      <details class="box"><summary>${t('season.create')}</summary>
        <form method="post" action="/admin/seasons" class="inline">
          <label>${t('field.number')} <input type="number" name="number" min="1" required value="${(seasons.at(-1)?.number || 0) + 1}"></label>
          <label>${t('season.titleOptional')} <input name="title"></label>
          <button>${t('common.create')}</button>
        </form></details>`));
  });

  r.post('/switch-podcast', (req, res) => {
    const id = Number(req.body.podcast_id);
    if (req.memberships.some((m) => m.id === id)) db.run('UPDATE sessions SET current_podcast_id = ? WHERE token = ?', id, req.sessionToken);
    res.redirect('/admin');
  });

  r.post('/seasons', (req, res) => {
    if (needPodcast(req, res)) return;
    const number = Number(req.body.number);
    if (!number) throw httpError(400, 'err.numberMissing');
    const exists = db.get('SELECT 1 FROM seasons WHERE podcast_id = ? AND number = ?', req.podcast.id, number);
    if (!exists) {
      const rr = db.run('INSERT INTO seasons (podcast_id, number, title) VALUES (?,?,?)', req.podcast.id, number, (req.body.title || '').trim());
      logChange(db, { ...ctx(req), type: 'season', id: Number(rr.lastInsertRowid), key: 'log.seasonCreated', params: { n: number } });
    }
    res.redirect('/admin');
  });

  // ---------- New episode ----------
  r.get('/episodes/new', (req, res) => {
    if (needPodcast(req, res)) return;
    const t = req.t;
    const seasons = db.all('SELECT * FROM seasons WHERE podcast_id = ? ORDER BY number', req.podcast.id);
    const nextNum = (db.get('SELECT MAX(number) AS n FROM episodes WHERE podcast_id = ?', req.podcast.id)?.n || 0) + 1;
    res.send(adminPage(req, t('overview.newEpisode'), html`<h1>${t('overview.newEpisode')}</h1>
      <form method="post" action="/admin/episodes" class="stack">
        <label>${t('field.title')} <input name="title" required autofocus></label>
        <label>${t('field.guest')} <input name="guest"></label>
        <div class="row">
          <label>${t('field.season')} <select name="season_id"><option value="">–</option>${seasons.map((s) => html`<option value="${s.id}" ${s === seasons.at(-1) ? raw('selected') : ''}>${t('season.label', { n: s.number })}</option>`)}</select></label>
          <label>${t('field.episodeNumber')} <input type="number" name="number" min="0" value="${nextNum}"></label>
        </div>
        <button class="primary">${t('common.create')}</button>
      </form>`));
  });

  r.post('/episodes', (req, res) => {
    if (needPodcast(req, res)) return;
    const title = (req.body.title || '').trim();
    if (!title) throw httpError(400, 'err.titleMissing');
    const number = req.body.number === '' ? null : Number(req.body.number);
    const seasonId = req.body.season_id ? Number(req.body.season_id) : null;
    if (seasonId && !db.get('SELECT 1 FROM seasons WHERE id = ? AND podcast_id = ?', seasonId, req.podcast.id)) throw httpError(400, 'err.seasonInvalid');
    let slug = slugify(`${number ?? ''} ${title}`);
    while (db.get('SELECT 1 FROM episodes WHERE podcast_id = ? AND slug = ?', req.podcast.id, slug)) slug += '-' + randomToken(2).toLowerCase();
    const pod = podcastRow(req);
    const rr = db.run(`INSERT INTO episodes (podcast_id, season_id, number, slug, title, guest, explicit, updated_by) VALUES (?,?,?,?,?,?,?,?)`,
      req.podcast.id, seasonId, number, slug, title, (req.body.guest || '').trim(), pod.explicit, req.user.id);
    const id = Number(rr.lastInsertRowid);
    logChange(db, { ...ctx(req), episodeId: id, type: 'episode', id, key: 'log.episodeCreated', params: { title } });
    res.redirect(`/admin/episodes/${id}`);
  });

  // ---------- Episode detail ----------
  r.get('/episodes/:id', (req, res) => {
    const t = req.t;
    const ep = loadEpisode(db, req, req.params.id);
    const pod = db.get('SELECT * FROM podcasts WHERE id = ?', ep.podcast_id);
    const seasons = db.all('SELECT * FROM seasons WHERE podcast_id = ? ORDER BY number', ep.podcast_id);
    const main = currentAudio(db, ep.id, 'main');
    const tr = db.get('SELECT language, version, updated_at FROM transcripts WHERE episode_id = ?', ep.id);
    const js = jobStatus(db, ep.id, t);
    const cl = computeChecklist(db, ep);
    const hist = episodeHistory(db, ep.id, 40);
    const warnOptions = JSON.parse(pod.content_warning_options || '[]');
    const warns = JSON.parse(ep.content_warnings || '[]');
    const lc = lastChange(db, ep.id);
    const counts = {
      chapters: db.get('SELECT COUNT(*) n FROM chapters WHERE episode_id = ? AND accepted = 1', ep.id).n,
      sections: db.get('SELECT COUNT(*) n FROM sections WHERE episode_id = ? AND accepted = 1', ep.id).n,
      proposals: db.get('SELECT (SELECT COUNT(*) FROM chapters WHERE episode_id = ?1 AND accepted = 0) + (SELECT COUNT(*) FROM sections WHERE episode_id = ?1 AND accepted = 0) n', ep.id).n,
    };
    const msgKey = { saved: 'msg.saved', conflict: 'msg.conflict', uploaded: 'msg.uploaded', published: 'msg.published', unpublished: 'msg.unpublished' }[req.query.m];
    const langName = (l) => LANGUAGES[l]?.name || l || '?';

    res.send(adminPage(req, ep.title, html`
      <p class="crumbs"><a href="/admin">${t('nav.episodes')}</a> ›</p>
      <div class="titlerow"><h1>${ep.number != null ? `#${ep.number} ` : ''}${ep.title}</h1>
        ${ep.status === 'published' ? html`<a class="button" href="/${pod.slug}/${ep.slug}" target="_blank" rel="noopener">${t('nav.publicPage')} ↗</a>` : ''}</div>
      ${lc ? html`<p class="muted">${t('common.lastChangedBy', { name: lc.user_name || t('common.system'), when: req.rel(lc.at) })}</p>` : ''}
      ${flash(msgKey ? t(msgKey) : '', req.query.m === 'conflict' ? 'warn' : 'info')}

      <div class="cols">
      <div>
        <section class="box">
          <h2>1. ${t('episode.audioHeading')}</h2>
          ${main ? html`<p><strong>${main.original_name}</strong> · ${fmtTime(main.duration)} · ${(main.size / 1048576).toFixed(1)} MB · ${t('episode.uploaded', { when: req.rel(main.created_at) })}</p>
            <audio controls preload="none" src="/media/audio/${main.id}"></audio>` : html`<p>${t('episode.noAudio')}</p>`}
          <form method="post" action="/admin/episodes/${ep.id}/audio" enctype="multipart/form-data" class="inline" data-upload>
            <input type="hidden" name="kind" value="main">
            <label>${main ? t('episode.uploadNewVersion') : t('episode.uploadMain')} (WAV, MP3, M4A)
              <input type="file" name="file" accept=".wav,.mp3,.m4a,.aif,.aiff,.flac,audio/*" required></label>
            <button>${t('common.upload')}</button>
            <progress hidden max="100" value="0"></progress>
          </form>
          ${!findFfmpeg() ? html`<p class="muted">${t('episode.noFfmpeg')}</p>` : ''}
        </section>

        <section class="box">
          <h2>2. ${t('episode.transcriptHeading')}</h2>
          <p>${t('episode.status')}: <strong>${tr ? t('episode.transcriptReady', { language: langName(tr.language) }) : js.label || t('episode.notRequested')}</strong>
            ${js.job?.status === 'error' ? html`<br><span class="err">${t('job.error')}: ${js.job.error}</span>` : ''}</p>
          <p class="muted">${heartbeatText(req, js.heartbeat)}</p>
          ${js.job && (js.job.status === 'error' || js.job.status === 'done') ? html`<form method="post" action="/admin/episodes/${ep.id}/retranscribe" class="inline">
            <label>${t('episode.spokenLanguage')} <select name="language"><option value="">${t('episode.autoDetect')}</option>
              ${Object.entries(LANGUAGES).map(([k, v]) => html`<option value="${k}">${v.name}</option>`)}</select></label>
            <button>${js.job.status === 'error' ? t('episode.retry') : t('episode.retranscribe')}</button></form>` : ''}
          ${tr ? html`<p><a class="button primary" href="/admin/episodes/${ep.id}/transcript">${t('episode.editTranscript')}</a></p>
            <p class="muted">${t('episode.counts', { chapters: counts.chapters, sections: counts.sections })}${counts.proposals ? html` · <strong>${t('episode.openProposals', { n: counts.proposals })}</strong>` : ''}
            ${claudeAvailable() ? '' : ' · ' + t('episode.noClaude')}</p>` : ''}
        </section>

        <section class="box">
          <h2>3. ${t('episode.detailsHeading')}</h2>
          <form method="post" action="/admin/episodes/${ep.id}" class="stack">
            <input type="hidden" name="version" value="${ep.version}">
            <label>${t('field.title')} <input name="title" value="${ep.title}" required></label>
            <div class="row">
              <label>${t('field.season')} <select name="season_id"><option value="">–</option>${seasons.map((s) => html`<option value="${s.id}" ${s.id === ep.season_id ? raw('selected') : ''}>${t('season.label', { n: s.number })}</option>`)}</select></label>
              <label>${t('field.number')} <input type="number" name="number" value="${ep.number ?? ''}"></label>
              <label>${t('field.slug')} <input name="slug" value="${ep.slug}" pattern="[a-z0-9-]+" title="${t('field.slugHint')}"></label>
            </div>
            <label>${t('field.guest')} <input name="guest" value="${ep.guest}"></label>
            <label>${t('field.description')} <textarea name="description" rows="6">${ep.description}</textarea></label>
            <fieldset><legend>${t('episode.labelling')}</legend>
              <label class="check"><input type="checkbox" name="explicit" value="1" ${ep.explicit ? raw('checked') : ''}> ${t('field.explicit')}</label>
              ${warnOptions.length ? warnOptions.map((w) => html`<label class="check"><input type="checkbox" name="content_warnings" value="${w}" ${warns.includes(w) ? raw('checked') : ''}> ${w}</label>`)
                : html`<p class="muted">${t('episode.warningsHint')} <a href="/admin/settings">${t('nav.settings')}</a></p>`}
              <label>${t('episode.moreWarnings')} <input name="content_warnings_extra" value="${warns.filter((w) => !warnOptions.includes(w)).join(', ')}"></label>
            </fieldset>
            <fieldset><legend>${t('field.guest')}</legend>
              <div class="row"><label>${t('field.consentDate')} <input type="date" name="consent_date" value="${ep.consent_date || ''}"></label>
              <label>${t('field.consentNote')} <input name="consent_note" value="${ep.consent_note}" placeholder="${t('episode.consentPlaceholder')}"></label></div>
              ${SHOW_PLANNED ? html`<label class="check"><input type="checkbox" name="guest_share_enabled" value="1" ${ep.guest_share_enabled ? raw('checked') : ''}> ${t('episode.guestShareOption')}</label>` : ''}
            </fieldset>
            <button class="primary">${t('common.save')}</button>
          </form>
          <form method="post" action="/admin/episodes/${ep.id}/cover" enctype="multipart/form-data" class="inline">
            ${ep.cover_path ? html`<img src="/media/cover/episode/${ep.id}" alt="${t('field.cover')}" width="80" height="80">` : html`<span class="muted">${t('episode.noOwnCover')}</span>`}
            <label>${t('episode.coverHint')} <input type="file" name="file" accept=".jpg,.jpeg,.png,.webp" required></label>
            <button>${t('episode.uploadCover')}</button>
          </form>
        </section>

        <section class="box">
          <h2>4. ${t('episode.publishHeading')}</h2>
          ${ep.status === 'published'
            ? html`<p>${t('episode.publishedWhen', { when: req.rel(ep.published_at) })}</p>
              <form method="post" action="/admin/episodes/${ep.id}/publish"><input type="hidden" name="action" value="unpublish"><button>${t('episode.unpublish')}</button></form>`
            : html`<p class="muted">${t('episode.publishHint')}</p>
              <form method="post" action="/admin/episodes/${ep.id}/publish"><input type="hidden" name="action" value="now">
              <button class="primary" ${main ? '' : raw('disabled')}>${t('episode.publishNow')}</button></form>`}
        </section>
      </div>

      <aside>
        <section class="box">
          <h2>${t('check.heading')} <small>${cl.done}/${cl.total}</small></h2>
          <div class="progress"><span style="width:${cl.percent}%"></span></div>
          <form method="post" action="/admin/episodes/${ep.id}/checklist">
          <ul class="checklist">${cl.items.map((i) => html`<li class="${i.done ? 'done' : ''}">
            ${i.auto ? html`<span class="tick" aria-hidden="true">${i.done ? '✓' : '○'}</span> ${t(i.labelKey)} ${i.detail ? html`<small>(${t(i.detail.key, i.detail.params)})</small>` : ''} <small class="muted">${t('check.automatic')}${i.stage ? `, ${t('check.stage', { n: i.stage })}` : ''}</small>`
              : html`<button class="tickbtn" name="step" value="${i.key}" aria-pressed="${i.done ? 'true' : 'false'}" title="${i.done ? t('check.untick') : t('check.tick')}">${i.done ? '✓' : '○'}</button> ${t(i.labelKey)}
                ${i.done && i.doneBy ? html`<small class="muted">${i.doneBy}, ${req.rel(i.doneAt)}</small>` : ''}${i.needsDate && i.detail ? html` <small>${t(i.detail.key, i.detail.params)}</small>` : ''}`}
          </li>`)}</ul></form>
        </section>
        <section class="box">
          <h2>${t('episode.history')}</h2>
          <ul class="history">${hist.map((h) => html`<li><small>${req.rel(h.at)}</small> <strong>${h.user_name || t('common.system')}</strong>: ${renderSummary(t, h.summary)}
            ${h.field && h.old_value != null && h.old_value.length < 80 && (h.new_value || '').length < 80 ? html`<br><small class="muted">“${h.old_value}” → “${h.new_value}”</small>` : ''}</li>`)}</ul>
        </section>
      </aside>
      </div>`, { scripts: ['/static/js/upload.js'], wide: true, strings: clientStrings(t.locale, 'upload.') }));
  });

  r.post('/episodes/:id', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const b = req.body;
    const pod = db.get('SELECT content_warning_options FROM podcasts WHERE id = ?', ep.podcast_id);
    const fixed = [].concat(b.content_warnings || []).filter((w) => JSON.parse(pod.content_warning_options).includes(w));
    const extra = String(b.content_warnings_extra || '').split(',').map((s) => s.trim()).filter(Boolean);
    const seasonId = b.season_id ? Number(b.season_id) : null;
    if (seasonId && !db.get('SELECT 1 FROM seasons WHERE id = ? AND podcast_id = ?', seasonId, ep.podcast_id)) throw httpError(400, 'err.seasonInvalid');
    let slug = slugify(b.slug || ep.slug);
    if (slug !== ep.slug && db.get('SELECT 1 FROM episodes WHERE podcast_id = ? AND slug = ? AND id != ?', ep.podcast_id, slug, ep.id)) slug = ep.slug;
    const next = {
      title: (b.title || '').trim() || ep.title, description: (b.description || '').trim(), guest: (b.guest || '').trim(),
      number: b.number === '' || b.number == null ? null : Number(b.number), season_id: seasonId, slug,
      explicit: b.explicit ? 1 : 0, content_warnings: JSON.stringify([...new Set([...fixed, ...extra])]),
      consent_date: b.consent_date || null, consent_note: (b.consent_note || '').trim(), guest_share_enabled: SHOW_PLANNED ? (b.guest_share_enabled ? 1 : 0) : ep.guest_share_enabled,
    };
    const conflict = Number(b.version) !== ep.version;
    db.tx(() => {
      const n = logFieldChanges(db, { ...ctx(req, ep), type: 'episode', id: ep.id }, ep, next, EPISODE_LABELS);
      if (n) {
        db.run(`UPDATE episodes SET title=?, description=?, guest=?, number=?, season_id=?, slug=?, explicit=?, content_warnings=?, consent_date=?, consent_note=?,
                guest_share_enabled=?, version = version + 1, updated_at = datetime('now'), updated_by = ? WHERE id = ?`,
          next.title, next.description, next.guest, next.number, next.season_id, next.slug, next.explicit, next.content_warnings, next.consent_date,
          next.consent_note, next.guest_share_enabled, req.user.id, ep.id);
      }
      // Entering a consent date ticks the checklist item
      if (next.consent_date && !ep.consent_date) setStep(req, ep, 'consent', true);
    });
    res.redirect(`/admin/episodes/${ep.id}?m=${conflict ? 'conflict' : 'saved'}`);
  });

  r.post('/episodes/:id/audio', async (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    await saveAudioUpload(db, req, ep, 'main');
    if (req.headers['x-requested-with'] === 'fetch') return res.json({ ok: true, redirect: `/admin/episodes/${ep.id}?m=uploaded` });
    res.redirect(`/admin/episodes/${ep.id}?m=uploaded`);
  });

  r.post('/episodes/:id/cover', async (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const { file } = await saveImageUpload(req, path.join(DATA_DIR, 'covers', String(ep.podcast_id)));
    if (!file) throw httpError(400, 'err.noImage');
    db.run('UPDATE episodes SET cover_path = ?, version = version + 1 WHERE id = ?', file.rel, ep.id);
    logChange(db, { ...ctx(req, ep), type: 'episode', id: ep.id, field: 'cover', key: 'log.coverUploaded' });
    res.redirect(`/admin/episodes/${ep.id}?m=saved`);
  });

  function setStep(req, ep, step, done) {
    db.run(`INSERT INTO checklist (episode_id, step, done, done_by, done_at) VALUES (?,?,?,?,datetime('now'))
             ON CONFLICT (episode_id, step) DO UPDATE SET done = excluded.done, done_by = excluded.done_by, done_at = excluded.done_at`,
      ep.id, step, done ? 1 : 0, req.user.id);
    logChange(db, { ...ctx(req, ep), type: 'checklist', id: ep.id, field: step, key: done ? 'log.ticked' : 'log.unticked', params: { step: `@check.${step}` } });
  }

  r.post('/episodes/:id/checklist', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const step = STEPS.find((s) => s.key === req.body.step && !s.auto);
    if (!step) throw httpError(400, 'err.unknownStep');
    const cur = db.get('SELECT done FROM checklist WHERE episode_id = ? AND step = ?', ep.id, step.key);
    db.tx(() => setStep(req, ep, step.key, !cur?.done));
    res.redirect(`/admin/episodes/${ep.id}`);
  });

  r.post('/episodes/:id/retranscribe', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    const main = currentAudio(db, ep.id, 'main');
    if (!main) throw httpError(400, 'err.noMainAudio');
    const lang = LANGUAGES[req.body.language] ? req.body.language : null;
    db.tx(() => {
      db.run(`UPDATE jobs SET status = 'error', error = 'cancelled' WHERE episode_id = ? AND status IN ('queued','running')`, ep.id);
      db.run(`INSERT INTO jobs (episode_id, audio_file_id, type, options) VALUES (?,?, 'transcribe', ?)`, ep.id, main.id, JSON.stringify({ language: lang, needsMp3: !main.mp3_path && !findFfmpeg() }));
      logChange(db, { ...ctx(req, ep), type: 'job', id: ep.id, key: 'log.retranscribe' });
    });
    res.redirect(`/admin/episodes/${ep.id}`);
  });

  r.post('/episodes/:id/publish', (req, res) => {
    const ep = loadEpisode(db, req, req.params.id);
    if (req.body.action === 'now') {
      if (!currentAudio(db, ep.id, 'main')) throw httpError(400, 'err.publishNeedsAudio');
      db.run(`UPDATE episodes SET status = 'published', published_at = COALESCE(published_at, datetime('now')), version = version + 1 WHERE id = ?`, ep.id);
      logChange(db, { ...ctx(req, ep), type: 'episode', id: ep.id, field: 'status', oldValue: ep.status, newValue: 'published', key: 'log.published' });
      return res.redirect(`/admin/episodes/${ep.id}?m=published`);
    }
    db.run(`UPDATE episodes SET status = 'draft', version = version + 1 WHERE id = ?`, ep.id);
    logChange(db, { ...ctx(req, ep), type: 'episode', id: ep.id, field: 'status', oldValue: ep.status, newValue: 'draft', key: 'log.unpublished' });
    res.redirect(`/admin/episodes/${ep.id}?m=unpublished`);
  });

  // ---------- Transcript editor (page; data via /api) ----------
  r.get('/episodes/:id/transcript', (req, res) => {
    const t = req.t;
    const ep = loadEpisode(db, req, req.params.id);
    const main = currentAudio(db, ep.id, 'main');
    res.send(adminPage(req, t('editor.pageTitle', { title: ep.title }), html`
      <p class="crumbs"><a href="/admin">${t('nav.episodes')}</a> › <a href="/admin/episodes/${ep.id}">${ep.title}</a> ›</p>
      <div id="editor" data-episode="${ep.id}" data-audio="${main ? `/media/audio/${main.id}` : ''}">
        <p>${t('editor.loading')}</p>
      </div>`, { scripts: ['/static/js/editor.js'], wide: true, strings: clientStrings(t.locale, 'editor.') }));
  });

  // ---------- Tags ----------
  r.get('/tags', (req, res) => {
    if (needPodcast(req, res)) return;
    const t = req.t;
    const tags = db.all(`SELECT t.*, COUNT(st.section_id) AS n FROM tags t LEFT JOIN section_tags st ON st.tag_id = t.id
                         WHERE t.podcast_id = ? GROUP BY t.id ORDER BY t.name COLLATE NOCASE`, req.podcast.id);
    res.send(adminPage(req, t('nav.tags'), html`<h1>${t('nav.tags')}</h1>
      <p class="muted">${t('tags.intro', { podcast: req.podcast.name })}</p>
      ${flash(req.query.m === 'merged' ? t('tags.merged') : req.query.m === 'saved' ? t('msg.saved') : '')}
      <table class="tags"><thead><tr><th>${t('tags.tag')}</th><th>${t('field.description')}</th><th>${t('tags.sections')}</th><th></th></tr></thead><tbody>
      ${tags.map((tag) => html`<tr>
        <td colspan="2"><form method="post" action="/admin/tags/${tag.id}" class="inline">
          <input name="name" value="${tag.name}" aria-label="${t('field.name')}" required> <input name="description" value="${tag.description}" aria-label="${t('field.description')}" placeholder="${t('field.description')}">
          <button>${t('common.save')}</button></form></td>
        <td>${tag.n}</td>
        <td><form method="post" action="/admin/tags/${tag.id}/delete" data-confirm="${t('tags.confirmDelete', { tag: tag.name })}"><button class="linkbtn danger">${t('common.delete')}</button></form></td>
      </tr>`)}</tbody></table>
      ${tags.length > 1 ? html`<section class="box"><h2>${t('tags.mergeHeading')}</h2>
        <form method="post" action="/admin/tags/merge" class="inline">
          <label>${t('tags.mergeFrom')} <select name="from">${tags.map((tag) => html`<option value="${tag.id}">${tag.name} (${tag.n})</option>`)}</select></label>
          <label>${t('tags.mergeInto')} <select name="into">${tags.map((tag) => html`<option value="${tag.id}">${tag.name} (${tag.n})</option>`)}</select></label>
          <button>${t('tags.merge')}</button></form></section>` : ''}
      <section class="box"><h2>${t('tags.new')}</h2><form method="post" action="/admin/tags" class="inline">
        <input name="name" required aria-label="${t('field.name')}" placeholder="${t('field.name')}"> <input name="description" aria-label="${t('field.description')}" placeholder="${t('field.description')}"> <button>${t('common.create')}</button></form></section>`,
      { scripts: ['/static/js/confirm.js'] }));
  });

  const ownTag = (req, id) => {
    const tag = db.get('SELECT * FROM tags WHERE id = ? AND podcast_id = ?', Number(id), req.podcast?.id);
    if (!tag) throw httpError(404, 'err.tagNotFound');
    return tag;
  };

  r.post('/tags', (req, res) => {
    if (needPodcast(req, res)) return;
    const name = (req.body.name || '').trim();
    if (name && !db.get('SELECT 1 FROM tags WHERE podcast_id = ? AND name = ? COLLATE NOCASE', req.podcast.id, name)) {
      const rr = db.run('INSERT INTO tags (podcast_id, name, description) VALUES (?,?,?)', req.podcast.id, name, (req.body.description || '').trim());
      logChange(db, { ...ctx(req), type: 'tag', id: Number(rr.lastInsertRowid), key: 'log.tagCreated', params: { tag: name } });
    }
    res.redirect('/admin/tags?m=saved');
  });

  r.post('/tags/merge', (req, res) => {
    const from = ownTag(req, req.body.from), into = ownTag(req, req.body.into);
    if (from.id !== into.id) {
      db.tx(() => {
        db.run('INSERT OR IGNORE INTO section_tags (section_id, tag_id) SELECT section_id, ? FROM section_tags WHERE tag_id = ?', into.id, from.id);
        db.run('DELETE FROM tags WHERE id = ?', from.id);
        logChange(db, { ...ctx(req), type: 'tag', id: into.id, key: 'log.tagMerged', params: { from: from.name, into: into.name } });
      });
    }
    res.redirect('/admin/tags?m=merged');
  });

  r.post('/tags/:id', (req, res) => {
    const tag = ownTag(req, req.params.id);
    const name = (req.body.name || '').trim() || tag.name;
    const clash = db.get('SELECT id FROM tags WHERE podcast_id = ? AND name = ? COLLATE NOCASE AND id != ?', tag.podcast_id, name, tag.id);
    if (clash) throw httpError(400, 'err.tagExists', { tag: name });
    db.tx(() => {
      logFieldChanges(db, { ...ctx(req), type: 'tag', id: tag.id }, tag, { name, description: (req.body.description || '').trim() },
        { name: 'field.name', description: 'field.description' }, { key: 'log.tagFieldChanged', params: { tag: tag.name } });
      db.run('UPDATE tags SET name = ?, description = ? WHERE id = ?', name, (req.body.description || '').trim(), tag.id);
    });
    res.redirect('/admin/tags?m=saved');
  });

  r.post('/tags/:id/delete', (req, res) => {
    const tag = ownTag(req, req.params.id);
    db.run('DELETE FROM tags WHERE id = ?', tag.id);
    logChange(db, { ...ctx(req), type: 'tag', id: tag.id, key: 'log.tagDeleted', params: { tag: tag.name } });
    res.redirect('/admin/tags?m=saved');
  });

  // ---------- Podcast settings ----------
  const podcastForm = (req, p, action, isNew) => {
    const t = req.t;
    const theme = JSON.parse(p.theme || '{}');
    const base = `${req.protocol}://${req.get('host')}/`;
    return html`<form method="post" action="${action}" class="stack">
      <div class="row"><label>${t('field.name')} <input name="name" value="${p.name || ''}" required></label>
      <label>${t('settings.slugLabel', { base })} <input name="slug" value="${p.slug || ''}" pattern="[a-z0-9-]+" required title="${t('field.slugHint')}"></label></div>
      <label>${t('field.subtitle')} <input name="subtitle" value="${p.subtitle || ''}"></label>
      <label>${t('field.description')} <textarea name="description" rows="4">${p.description || ''}</textarea></label>
      <div class="row"><label>${t('field.author')} <input name="author" value="${p.author || ''}"></label>
      <label>${t('field.ownerEmail')} <input type="email" name="owner_email" value="${p.owner_email || ''}"></label></div>
      <div class="row"><label>${t('field.language')} <select name="language">${Object.entries(LANGUAGES).map(([k, v]) => html`<option value="${k}" ${p.language === k ? raw('selected') : ''}>${v.name}</option>`)}</select></label>
      <label>${t('field.category')} <input name="category" value="${p.category || ''}" placeholder="${t('settings.categoryPlaceholder')}"></label>
      <label class="check"><input type="checkbox" name="explicit" value="1" ${p.explicit ? raw('checked') : ''}> ${t('settings.explicitDefault')}</label></div>
      <p class="muted small">${t('settings.languageHint')}</p>
      <fieldset><legend>${t('settings.designHeading')}</legend><div class="row">
        <label>${t('settings.accent')} <input type="color" name="accent" value="${theme.accent || '#7b2cbf'}"></label>
        <label>${t('settings.background')} <input type="color" name="bg" value="${theme.bg || '#ffffff'}"></label>
        <label>${t('settings.text')} <input type="color" name="fg" value="${theme.fg || '#1a1a1a'}"></label>
        <label>${t('settings.pattern')} <select name="pattern">${['none', 'moire', 'lightpainting'].map((v) => html`<option value="${v}" ${theme.pattern === v ? raw('selected') : ''}>${t('pattern.' + v)}</option>`)}</select></label>
      </div><p class="muted">${t('settings.contrastHint')}</p></fieldset>
      <label>${t('settings.warningOptions')} <textarea name="content_warning_options" rows="4">${JSON.parse(p.content_warning_options || '[]').join('\n')}</textarea></label>
      ${SHOW_PLANNED ? html`<label>${t('settings.autocutDefault')} <select name="autocut_default">${AUTOCUT_LEVELS.map((l) => html`<option value="${l}" ${p.autocut_default === l ? raw('selected') : ''}>${t('autocut.' + l)}</option>`)}</select></label>` : ''}
      <button class="primary">${isNew ? t('podcast.create') : t('common.save')}</button></form>`;
  };

  const readPodcastForm = (b, current) => {
    const slug = slugify(b.slug || b.name);
    if (RESERVED_SLUGS.has(slug)) throw httpError(400, 'err.slugReserved', { slug });
    return {
      name: (b.name || '').trim(), slug, subtitle: (b.subtitle || '').trim(), description: (b.description || '').trim(), author: (b.author || '').trim(),
      owner_email: (b.owner_email || '').trim(), language: LANGUAGES[b.language] ? b.language : 'en', category: (b.category || '').trim(), explicit: b.explicit ? 1 : 0,
      theme: JSON.stringify({ accent: b.accent, bg: b.bg, fg: b.fg, pattern: b.pattern }),
      content_warning_options: JSON.stringify(String(b.content_warning_options || '').split('\n').map((s) => s.trim()).filter(Boolean)),
      autocut_default: AUTOCUT_LEVELS.includes(b.autocut_default) ? b.autocut_default : current?.autocut_default || 'off',
    };
  };

  r.get('/settings', (req, res) => {
    if (needPodcast(req, res)) return;
    const t = req.t;
    const p = podcastRow(req);
    const admin = isPodcastAdmin(req, p.id);
    res.send(adminPage(req, t('nav.settings'), html`<h1>${t('settings.title', { podcast: p.name })}</h1>
      ${flash(req.query.m === 'saved' ? t('msg.saved') : '')}
      ${admin ? podcastForm(req, p, '/admin/settings', false) : html`<p>${t('settings.adminsOnly')}</p>`}
      ${admin ? html`<section class="box"><h2>${t('settings.coverHeading')}</h2>
        ${p.cover_path ? html`<img src="/media/cover/podcast/${p.id}" alt="${t('field.cover')}" width="120" height="120">` : ''}
        <form method="post" action="/admin/settings/cover" enctype="multipart/form-data" class="inline">
          <label>${t('settings.coverHint')} <input type="file" name="file" accept=".jpg,.jpeg,.png,.webp" required></label><button>${t('common.upload')}</button></form></section>` : ''}
      ${req.user.isSuperadmin ? html`<p><a href="/admin/podcasts/new">+ ${t('podcast.addAnother')}</a></p>` : ''}`));
  });

  r.post('/settings', (req, res) => {
    if (needPodcast(req, res)) return;
    if (!isPodcastAdmin(req, req.podcast.id)) throw httpError(403, 'err.forbidden');
    const p = podcastRow(req);
    const next = readPodcastForm(req.body, p);
    if (db.get('SELECT 1 FROM podcasts WHERE slug = ? AND id != ?', next.slug, p.id)) throw httpError(400, 'err.slugTaken');
    db.tx(() => {
      logFieldChanges(db, { ...ctx(req), type: 'podcast', id: p.id }, p, next, PODCAST_LABELS);
      db.run(`UPDATE podcasts SET name=?, slug=?, subtitle=?, description=?, author=?, owner_email=?, language=?, category=?, explicit=?, theme=?, content_warning_options=?, autocut_default=? WHERE id=?`,
        next.name, next.slug, next.subtitle, next.description, next.author, next.owner_email, next.language, next.category, next.explicit, next.theme, next.content_warning_options, next.autocut_default, p.id);
    });
    res.redirect('/admin/settings?m=saved');
  });

  r.post('/settings/cover', async (req, res) => {
    if (needPodcast(req, res)) return;
    if (!isPodcastAdmin(req, req.podcast.id)) throw httpError(403, 'err.forbidden');
    const { file } = await saveImageUpload(req, path.join(DATA_DIR, 'covers', String(req.podcast.id)));
    if (!file) throw httpError(400, 'err.noImage');
    db.run('UPDATE podcasts SET cover_path = ? WHERE id = ?', file.rel, req.podcast.id);
    logChange(db, { ...ctx(req), type: 'podcast', id: req.podcast.id, field: 'cover', key: 'log.podcastCoverUploaded' });
    res.redirect('/admin/settings?m=saved');
  });

  r.get('/podcasts/new', (req, res) => {
    if (!req.user.isSuperadmin) throw httpError(403, 'err.superadminOnly');
    const t = req.t;
    res.send(adminPage(req, t('podcast.new'), html`<h1>${t('podcast.new')}</h1>${podcastForm(req, { language: t.locale, theme: '{}', content_warning_options: '[]' }, '/admin/podcasts/new', true)}`));
  });

  r.post('/podcasts/new', (req, res) => {
    if (!req.user.isSuperadmin) throw httpError(403, 'err.superadminOnly');
    const p = readPodcastForm(req.body);
    if (!p.name) throw httpError(400, 'err.nameMissing');
    if (db.get('SELECT 1 FROM podcasts WHERE slug = ?', p.slug)) throw httpError(400, 'err.slugTaken');
    const id = db.tx(() => {
      const rr = db.run(`INSERT INTO podcasts (name, slug, subtitle, description, author, owner_email, language, category, explicit, theme, content_warning_options, autocut_default)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, p.name, p.slug, p.subtitle, p.description, p.author, p.owner_email, p.language, p.category, p.explicit, p.theme, p.content_warning_options, p.autocut_default);
      const pid = Number(rr.lastInsertRowid);
      db.run('INSERT INTO memberships (user_id, podcast_id, role) VALUES (?,?,?)', req.user.id, pid, 'admin');
      db.run('INSERT INTO seasons (podcast_id, number) VALUES (?, 1)', pid);
      logChange(db, { user: req.user, podcastId: pid, type: 'podcast', id: pid, key: 'log.podcastCreated', params: { name: p.name } });
      return pid;
    });
    db.run('UPDATE sessions SET current_podcast_id = ? WHERE token = ?', id, req.sessionToken);
    res.redirect('/admin/settings?m=saved');
  });

  // ---------- Team ----------
  r.get('/team', (req, res) => {
    if (needPodcast(req, res)) return;
    const t = req.t;
    const members = db.all(`SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.podcast_id = ? ORDER BY u.name`, req.podcast.id);
    const invites = db.all(`SELECT * FROM invites WHERE podcast_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC`, req.podcast.id, new Date().toISOString());
    const admin = isPodcastAdmin(req, req.podcast.id);
    const base = `${req.protocol}://${req.get('host')}`;
    const role = (r2) => (r2 === 'admin' ? t('role.admin') : t('role.editor'));
    res.send(adminPage(req, t('nav.team'), html`<h1>${t('team.title', { podcast: req.podcast.name })}</h1>
      <ul>${members.map((m) => html`<li>${m.name} (${m.email}) – ${role(m.role)}
        ${admin && m.id !== req.user.id ? html`<form method="post" action="/admin/team/${m.id}/remove" class="inline" data-confirm="${t('team.confirmRemove', { name: m.name })}"><button class="linkbtn danger">${t('team.remove')}</button></form>` : ''}</li>`)}</ul>
      ${admin ? html`<section class="box"><h2>${t('team.inviteHeading')}</h2>
        <form method="post" action="/admin/team/invite" class="inline">
          <label>${t('login.email')} <input type="email" name="email" required></label>
          <label>${t('team.role')} <select name="role"><option value="editor">${t('role.editor')}</option><option value="admin">${t('role.admin')}</option></select></label>
          <button>${t('team.createLink')}</button></form>
        <p class="muted">${t('team.linkHint')}</p>
        ${invites.length ? html`<h3>${t('team.openInvites')}</h3><ul>${invites.map((i) => html`<li>${i.email} (${role(i.role)}): <input readonly value="${base}/invite/${i.token}" onclick="this.select()" size="50" aria-label="${t('team.inviteLink')}"></li>`)}</ul>` : ''}
      </section>` : ''}`, { scripts: ['/static/js/confirm.js'] }));
  });

  r.post('/team/invite', (req, res) => {
    if (needPodcast(req, res)) return;
    if (!isPodcastAdmin(req, req.podcast.id)) throw httpError(403, 'err.forbidden');
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email.includes('@')) throw httpError(400, 'err.emailInvalid');
    const role = req.body.role === 'admin' ? 'admin' : 'editor';
    db.run('INSERT INTO invites (token, podcast_id, email, role, created_by, expires_at) VALUES (?,?,?,?,?,?)',
      randomToken(), req.podcast.id, email, role, req.user.id, new Date(Date.now() + 14 * 864e5).toISOString());
    logChange(db, { ...ctx(req), type: 'invite', key: 'log.invited', params: { email } });
    res.redirect('/admin/team');
  });

  r.post('/team/:uid/remove', (req, res) => {
    if (needPodcast(req, res)) return;
    if (!isPodcastAdmin(req, req.podcast.id)) throw httpError(403, 'err.forbidden');
    const u = db.get('SELECT name FROM users WHERE id = ?', Number(req.params.uid));
    db.run('DELETE FROM memberships WHERE user_id = ? AND podcast_id = ?', Number(req.params.uid), req.podcast.id);
    logChange(db, { ...ctx(req), type: 'membership', id: Number(req.params.uid), key: 'log.removedFromTeam', params: { name: u?.name || '?' } });
    res.redirect('/admin/team');
  });

  return r;
}
