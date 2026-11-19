import { Router } from 'express';
import { html, raw, fmtTime, jsonScript, esc } from '../lib/html.js';
import { publicPage } from '../lib/layout.js';
import { toParagraphs } from '../lib/transcript.js';
import { currentAudio } from '../lib/episodes.js';
import { translator, isLocale, fromAcceptLanguage, clientStrings } from '../lib/i18n.js';

// FTS5 query from user input: every word as a prefix search
export function ftsQuery(q) {
  const terms = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return terms.slice(0, 8).map((t) => `"${t}"*`).join(' ');
}

const RATES = ['0.75', '1', '1.25', '1.5', '1.75', '2'];

export default function publicRoutes(db) {
  const r = Router();

  const podcastBySlug = (slug) => db.get('SELECT * FROM podcasts WHERE slug = ?', slug);
  // Public pages speak the podcast's language (if the UI supports it)
  const tFor = (podcast) => translator(isLocale(podcast.language) ? podcast.language : 'en');
  const publishedEpisodes = (podcastId) => db.all(`SELECT e.*, s.number AS season_number FROM episodes e LEFT JOIN seasons s ON s.id = e.season_id
    WHERE e.podcast_id = ? AND e.status = 'published' ORDER BY COALESCE(s.number, 0) DESC, e.number DESC, e.published_at DESC`, podcastId);
  const warningsOf = (ep) => { try { return JSON.parse(ep.content_warnings || '[]'); } catch { return []; } };
  const epLabel = (t, e) => `${e.season_number ? t('pub.seasonShort', { n: e.season_number }) + ' ' : ''}${e.number != null ? `#${e.number}` : ''}`.trim();
  const base = (req) => `${req.protocol}://${req.get('host')}`;
  const rateSelect = (t) => html`<label>${t('pub.speed')} <select data-act="rate">${RATES.map((v) => html`<option value="${v}" ${v === '1' ? raw('selected') : ''}>${v}×</option>`)}</select></label>`;

  r.get('/', (req, res) => {
    const pods = db.all(`SELECT p.*, COUNT(e.id) AS n FROM podcasts p JOIN episodes e ON e.podcast_id = p.id AND e.status = 'published' GROUP BY p.id ORDER BY p.name`);
    if (pods.length === 1) return res.redirect(`/${pods[0].slug}`);
    const t = translator(fromAcceptLanguage(req.headers['accept-language']));
    res.send(publicPage(t, null, 'Hallraum', html`<div class="wrap"><h1>${t('pub.podcasts')}</h1>
      ${pods.length ? html`<ul class="podlist">${pods.map((p) => html`<li><a href="/${p.slug}">
        ${p.cover_path ? html`<img src="/media/cover/podcast/${p.id}" alt="" width="96" height="96">` : ''}
        <span><strong>${p.name}</strong><br>${p.subtitle}<br><small>${t('pub.episodeCount', { n: p.n })}</small></span></a></li>`)}</ul>`
      : html`<p>${t('pub.noPodcasts')}</p>`}</div>`));
  });

  // ----- Podcast home -----
  r.get('/:slug', (req, res, next) => {
    const p = podcastBySlug(req.params.slug);
    if (!p) return next();
    const t = tFor(p);
    const eps = publishedEpisodes(p.id);
    const tags = db.all(`SELECT t.name, COUNT(*) AS n FROM tags t JOIN section_tags st ON st.tag_id = t.id JOIN sections s ON s.id = st.section_id
      JOIN episodes e ON e.id = s.episode_id WHERE t.podcast_id = ? AND e.status = 'published' AND s.accepted = 1 GROUP BY t.id ORDER BY n DESC, t.name LIMIT 60`, p.id);
    res.send(publicPage(t, p, p.name, html`<div class="wrap">
      <section class="hero">
        ${p.cover_path ? html`<img src="/media/cover/podcast/${p.id}" alt="${t('pub.coverOf', { name: p.name })}" width="200" height="200">` : ''}
        <div><h1>${p.name}</h1>${p.subtitle ? html`<p class="subtitle">${p.subtitle}</p>` : ''}<p>${p.description}</p></div>
      </section>
      ${tags.length ? html`<section><h2>${t('pub.topics')}</h2><p class="muted">${t('pub.topicsHint')}</p>
        <ul class="tagcloud">${tags.map((tag) => html`<li><a href="/${p.slug}/topic/${encodeURIComponent(tag.name)}">${tag.name} <small>${tag.n}</small></a></li>`)}</ul></section>` : ''}
      <section><h2>${t('pub.episodes')}</h2>
      ${eps.length ? html`<ul class="pubeps">${eps.map((e) => {
        const a = currentAudio(db, e.id, 'main');
        const w = warningsOf(e);
        return html`<li><a href="/${p.slug}/${e.slug}"><span class="eplabel">${epLabel(t, e)}</span> <strong>${e.title}</strong></a>
          <small>${a?.duration ? fmtTime(a.duration) : ''}${e.explicit ? ' · ' + t('pub.explicit') : ''}</small>
          ${w.length ? html`<small class="cw">${t('pub.contentWarnings')}: ${w.join(', ')}</small>` : ''}
          ${e.description ? html`<p>${e.description.slice(0, 280)}${e.description.length > 280 ? '…' : ''}</p>` : ''}</li>`;
      })}</ul>` : html`<p>${t('pub.firstSoon')}</p>`}</section></div>`,
      { description: p.subtitle || p.description.slice(0, 160), canonical: `${base(req)}/${p.slug}` }));
  });

  // ----- Search across all episodes -----
  r.get('/:slug/search', (req, res, next) => {
    const p = podcastBySlug(req.params.slug);
    if (!p) return next();
    const t = tFor(p);
    const q = String(req.query.q || '').slice(0, 200);
    const fq = ftsQuery(q);
    const hits = fq ? db.all(`SELECT f.episode_id, f.start, snippet(transcript_fts, 0, '[[', ']]', ' … ', 18) AS snip, e.title, e.slug, e.number
      FROM transcript_fts f JOIN episodes e ON e.id = f.episode_id
      WHERE transcript_fts MATCH ? AND f.podcast_id = ? AND e.status = 'published' ORDER BY rank LIMIT 100`, fq, p.id) : [];
    const mark = (s) => raw(esc(s).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>'));
    res.send(publicPage(t, p, `${t('pub.search')}: ${q}`, html`<div class="wrap"><h1>${t('pub.search')}</h1>
      <form method="get" role="search" class="bigsearch"><label for="q2" class="sr-only">${t('pub.searchTerm')}</label>
        <input id="q2" name="q" type="search" value="${q}" placeholder="${t('pub.searchTerm')}"> <button>${t('pub.search')}</button></form>
      ${q ? html`<p data-hits="${hits.length}">${t('pub.hits', { n: hits.length })}${hits.length === 100 ? ' ' + t('pub.first100') : ''}</p>` : ''}
      <ul class="hits">${hits.map((h) => html`<li><a href="/${p.slug}/${h.slug}?t=${Math.floor(h.start)}"><strong>${h.title}</strong> · ${fmtTime(h.start)}</a><br>${mark(h.snip)}</li>`)}</ul></div>`));
  });

  // ----- Topic playlist across episodes -----
  r.get('/:slug/topic/:tag', (req, res, next) => {
    const p = podcastBySlug(req.params.slug);
    if (!p) return next();
    const t = tFor(p);
    const tag = db.get('SELECT * FROM tags WHERE podcast_id = ? AND name = ? COLLATE NOCASE', p.id, req.params.tag);
    if (!tag) return next();
    const items = db.all(`SELECT s.id, s.start, s.end, s.title, e.id AS episode_id, e.title AS episode_title, e.slug, e.number, e.content_warnings, a.id AS audio_id
      FROM sections s JOIN section_tags st ON st.section_id = s.id JOIN episodes e ON e.id = s.episode_id
      JOIN audio_files a ON a.episode_id = e.id AND a.kind = 'main' AND a.is_current = 1
      WHERE st.tag_id = ? AND s.accepted = 1 AND e.status = 'published' ORDER BY e.published_at, e.number, s.start`, tag.id);
    const list = items.map((i) => ({ id: i.id, start: i.start, end: i.end, title: i.title, episode: i.episode_title, url: `/${p.slug}/${i.slug}`, audio: `/media/audio/${i.audio_id}`, warnings: warningsOf(i) }));
    const warnings = [...new Set(list.flatMap((i) => i.warnings))];
    const total = list.reduce((s, i) => s + (i.end - i.start), 0);
    res.send(publicPage(t, p, `${t('pub.topic')}: ${tag.name} · ${p.name}`, html`<div class="wrap">
      <p class="crumbs"><a href="/${p.slug}">${p.name}</a> › ${t('pub.topic')}</p>
      <h1>${t('pub.topic')}: ${tag.name}</h1>
      ${tag.description ? html`<p>${tag.description}</p>` : ''}
      <p>${t('pub.playlistSummary', { sections: list.length, episodes: new Set(items.map((i) => i.episode_id)).size, duration: fmtTime(total) })}</p>
      ${warnings.length ? html`<p class="cw" role="note"><strong>${t('pub.contentWarnings')}:</strong> ${warnings.join(', ')}</p>` : ''}
      <div class="player" id="player" data-mode="playlist">
        <audio preload="none"></audio>
        <div class="controls">
          <button data-act="playall" class="primary">▶ ${t('pub.playAll')}</button>
          <button data-act="back" aria-label="${t('pub.back15')}">−15</button>
          <button data-act="toggle" aria-label="${t('pub.playPause')}">▶︎❚❚</button>
          <button data-act="fwd" aria-label="${t('pub.fwd15')}">+15</button>
          <button data-act="next" aria-label="${t('pub.nextSection')}">⏭</button>
          ${rateSelect(t)}
        </div>
        <p class="now" aria-live="polite"></p>
        <input type="range" class="seek" min="0" max="1000" value="0" aria-label="${t('pub.positionInSection')}">
      </div>
      <ol class="playlist">${list.map((i, n) => html`<li data-n="${n}"><button class="linkbtn" data-play="${n}">▶ <strong>${i.title || t('pub.section')}</strong></button>
        <small>${i.episode} · ${fmtTime(i.start)}–${fmtTime(i.end)}</small> <a href="${i.url}?t=${Math.floor(i.start)}">${t('pub.openInEpisode')}</a></li>`)}</ol>
      ${jsonScript('playlist-data', list)}</div>`, { scripts: ['/static/js/listen.js'], strings: clientStrings(t.locale, 'player.') }));
  });

  // ----- Episode page -----
  r.get('/:slug/:ep', (req, res, next) => {
    const p = podcastBySlug(req.params.slug);
    if (!p) return next();
    const t = tFor(p);
    const ep = db.get(`SELECT e.*, s.number AS season_number FROM episodes e LEFT JOIN seasons s ON s.id = e.season_id
      WHERE e.podcast_id = ? AND e.slug = ? AND e.status = 'published'`, p.id, req.params.ep);
    if (!ep) return next();
    const audio = currentAudio(db, ep.id, 'main');
    const tr = db.get('SELECT words, language FROM transcripts WHERE episode_id = ?', ep.id);
    const words = tr ? JSON.parse(tr.words) : [];
    const speakers = JSON.parse(ep.speaker_names || '{}');
    const chapters = db.all('SELECT start, title, summary FROM chapters WHERE episode_id = ? AND accepted = 1 ORDER BY start', ep.id);
    const sections = db.all(`SELECT s.id, s.start, s.end, s.title, GROUP_CONCAT(t.name, '|') AS tags FROM sections s
      LEFT JOIN section_tags st ON st.section_id = s.id LEFT JOIN tags t ON t.id = st.tag_id
      WHERE s.episode_id = ? AND s.accepted = 1 GROUP BY s.id ORDER BY s.start`, ep.id).map((s) => ({ ...s, tags: s.tags ? s.tags.split('|') : [] }));
    const warnings = warningsOf(ep);
    const paras = toParagraphs(words);
    let wi = 0;
    const transcriptHtml = paras.map((para) => html`<p class="para"><span class="who">${speakers[para.sp] || para.sp || ''}</span>
      <a class="ts" href="?t=${Math.floor(para.start)}" data-seek="${para.start}">${fmtTime(para.start)}</a>
      ${raw(para.idx.map((i) => `<span data-i="${wi++}" data-s="${words[i].s}"${words[i].f ? ' class="f"' : ''}>${esc(words[i].w)}</span>`).join(' '))}</p>`);
    const desc = ep.description || chapters.map((c) => c.title).join(' · ');
    res.send(publicPage(t, p, `${ep.title} · ${p.name}`, html`<div class="wrap episode">
      <p class="crumbs"><a href="/${p.slug}">${p.name}</a> › ${epLabel(t, ep)}</p>
      <h1>${ep.title}</h1>
      ${ep.guest ? html`<p class="subtitle">${t('pub.withGuest', { guest: ep.guest })}</p>` : ''}
      ${warnings.length || ep.explicit ? html`<div class="cw" role="note"><strong>${t('pub.beforeListening')}</strong>
        ${ep.explicit ? t('pub.explicit') + '. ' : ''}${warnings.length ? `${t('pub.contentWarnings')}: ${warnings.join(', ')}.` : ''}</div>` : ''}
      <div class="player" id="player" data-mode="episode" data-episode="${ep.id}">
        <audio preload="metadata" src="${audio ? `/media/audio/${audio.id}` : ''}"></audio>
        <div class="controls">
          <button data-act="back" aria-label="${t('pub.back15')}">−15</button>
          <button data-act="toggle" class="primary play" aria-label="${t('player.play')}">▶</button>
          <button data-act="fwd" aria-label="${t('pub.fwd15')}">+15</button>
          <span class="time" aria-live="off"><span data-cur>0:00</span> / <span data-dur>${fmtTime(audio?.duration)}</span></span>
          ${rateSelect(t)}
          <button data-act="share" title="${t('pub.shareHint')}">${t('pub.share')}</button>
        </div>
        <input type="range" class="seek" min="0" max="${Math.ceil(audio?.duration || 0)}" step="1" value="0" aria-label="${t('pub.position')}">
        <p class="now chapter-now" aria-live="polite"></p>
      </div>
      ${ep.description ? html`<div class="desc">${ep.description.split(/\n{2,}/).map((x) => html`<p>${x}</p>`)}</div>` : ''}
      <div class="epcols">
        <aside>
          ${chapters.length ? html`<h2>${t('pub.chapters')}</h2><ol class="chapters">${chapters.map((c, n) => html`<li data-start="${c.start}" data-n="${n}">
            <a href="?t=${Math.floor(c.start)}" data-seek="${c.start}"><span class="ts">${fmtTime(c.start)}</span> ${c.title}</a>
            ${c.summary ? html`<small>${c.summary}</small>` : ''}</li>`)}</ol>` : ''}
          ${sections.some((s) => s.tags.length) ? html`<h2>${t('pub.topicsInEpisode')}</h2><ul class="sections">${sections.filter((s) => s.tags.length).map((s) => html`<li>
            <a href="?t=${Math.floor(s.start)}" data-seek="${s.start}"><span class="ts">${fmtTime(s.start)}</span> ${s.title}</a>
            <span class="tags">${s.tags.map((tag) => html`<a href="/${p.slug}/topic/${encodeURIComponent(tag)}">${tag}</a>`)}</span></li>`)}</ul>` : ''}
        </aside>
        <section class="transcript-wrap">
          <div class="titlerow"><h2>${t('pub.transcript')}</h2>
            <form class="tsearch" role="search" onsubmit="return false"><label for="tq" class="sr-only">${t('pub.searchEpisode')}</label>
              <input id="tq" type="search" placeholder="${t('pub.searchEpisode')}"> <span class="tcount" aria-live="polite"></span></form>
            <label class="check"><input type="checkbox" id="follow" checked> ${t('pub.follow')}</label></div>
          ${words.length ? html`<div class="transcript" id="transcript" lang="${tr.language || p.language}">${transcriptHtml}</div>` : html`<p class="muted">${t('pub.noTranscript')}</p>`}
        </section>
      </div></div>`, { scripts: ['/static/js/listen.js'], strings: clientStrings(t.locale, 'player.'), description: desc.slice(0, 160), canonical: `${base(req)}/${p.slug}/${ep.slug}` }));
  });

  return r;
}
