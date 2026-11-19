import { html, raw, esc, jsonScript } from './html.js';
import { LOCALE_NAMES } from './i18n.js';

// Changes on every restart so browsers fetch fresh CSS/JS after updates
const V = Date.now().toString(36);
const asset = (u) => `${u}?v=${V}`;

const head = (lang, title, extra = '') => html`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${asset('/static/css/app.css')}">
${raw(extra)}
</head>`;

const scriptTags = (scripts) => scripts.map((s) => html`<script type="module" src="${asset(s)}"></script>`);

// Admin pages. `strings` are passed to browser scripts as window JSON (#i18n).
export function adminPage(req, title, body, { scripts = [], wide = false, strings = null } = {}) {
  const t = req.t;
  const u = req.user;
  const pods = req.memberships || [];
  const nav = html`
<header class="topbar">
  <a class="brand" href="/admin">Hallraum</a>
  ${pods.length > 1 ? html`<form method="post" action="/admin/switch-podcast" class="podswitch">
      <label class="sr-only" for="podsel">${t('nav.podcast')}</label>
      <select id="podsel" name="podcast_id" onchange="this.form.submit()">
        ${pods.map((p) => html`<option value="${p.id}" ${p.id === req.podcast?.id ? raw('selected') : ''}>${p.name}</option>`)}
      </select><noscript><button>${t('nav.switch')}</button></noscript></form>`
    : req.podcast ? html`<span class="podname">${req.podcast.name}</span>` : ''}
  <nav>
    <a href="/admin">${t('nav.episodes')}</a>
    <a href="/admin/tags">${t('nav.tags')}</a>
    <a href="/admin/settings">${t('nav.settings')}</a>
    <a href="/admin/team">${t('nav.team')}</a>
    ${req.podcast ? html`<a href="/${req.podcast.slug}" target="_blank" rel="noopener">${t('nav.publicPage')} ↗</a>` : ''}
  </nav>
  <div class="logout">
    <form method="post" action="/admin/language" class="inline">
      <label class="sr-only" for="langsel">${t('nav.language')}</label>
      <select id="langsel" name="locale" onchange="this.form.submit()">
        ${Object.entries(LOCALE_NAMES).map(([k, v]) => html`<option value="${k}" ${k === t.locale ? raw('selected') : ''}>${v}</option>`)}
      </select><noscript><button>OK</button></noscript>
    </form>
    <form method="post" action="/logout" class="inline"><span>${u?.name}</span> <button class="linkbtn">${t('nav.logout')}</button></form>
  </div>
</header>`;
  return html`${head(t.locale, `${title} · Hallraum`)}
<body class="admin">
${nav}
<main class="${wide ? 'wide' : ''}">${body}</main>
${strings ? jsonScript('i18n', strings) : ''}
${scriptTags(scripts)}
</body></html>`.toString();
}

export function plainPage(t, title, body) {
  return html`${head(t.locale, `${title} · Hallraum`)}<body class="admin plain"><main class="narrow">
    <p class="brand-plain">Hallraum</p>${body}</main></body></html>`.toString();
}

// Public pages: look comes from the podcast settings, language from the podcast language
export function publicPage(t, podcast, title, body, { scripts = [], description = '', canonical = '', strings = null } = {}) {
  let theme = {};
  try { theme = JSON.parse(podcast?.theme || '{}'); } catch {}
  const vars = [];
  const color = (k, v) => /^#[0-9a-f]{3,8}$/i.test(v || '') && vars.push(`--${k}:${v}`);
  color('accent', theme.accent); color('bg', theme.bg); color('fg', theme.fg); color('accent-fg', theme.accentFg);
  const pattern = ['moire', 'lightpainting', 'none'].includes(theme.pattern) ? theme.pattern : 'none';
  const extra = [
    description ? `<meta name="description" content="${esc(description)}">` : '',
    canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '',
    vars.length ? `<style>:root{${vars.join(';')}}</style>` : '',
  ].join('\n');
  return html`${head(t.locale, title, extra)}
<body class="public pattern-${pattern}">
<a class="skip" href="#content">${t('pub.skip')}</a>
${podcast ? html`<header class="pubhead">
  <a href="/${podcast.slug}" class="pubbrand">
    ${podcast.cover_path ? html`<img src="/media/cover/podcast/${podcast.id}" alt="" width="56" height="56">` : ''}
    <span><strong>${podcast.name}</strong>${podcast.subtitle ? html`<small>${podcast.subtitle}</small>` : ''}</span>
  </a>
  <form action="/${podcast.slug}/search" method="get" role="search" class="pubsearch">
    <label class="sr-only" for="q">${t('pub.searchAll')}</label>
    <input id="q" name="q" type="search" placeholder="${t('pub.searchAllPlaceholder')}">
  </form>
</header>` : ''}
<main id="content">${body}</main>
${strings ? jsonScript('i18n', strings) : ''}
${scriptTags(scripts)}
</body></html>`.toString();
}

export const flash = (msg, kind = 'info') => (msg ? html`<p class="flash ${kind}" role="status">${msg}</p>` : '');
