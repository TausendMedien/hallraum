import { Router } from 'express';
import { html } from '../lib/html.js';
import { plainPage, flash } from '../lib/layout.js';
import { verifyPassword, hashPassword, createSession, sessionCookie } from '../lib/auth.js';
import { logChange } from '../lib/audit.js';
import { isLocale } from '../lib/i18n.js';

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/admin');

// Simple brake against password guessing: max 10 failures per IP in 15 minutes
const attempts = new Map();
const WINDOW = 15 * 60e3;
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of attempts) if (!list.some((t) => now - t < WINDOW)) attempts.delete(ip);
}, WINDOW).unref();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < WINDOW);
  attempts.set(ip, list);
  return list.length >= 10;
}

export default function authRoutes(db) {
  const r = Router();

  const loginForm = (t, next, msg, email = '') => plainPage(t, t('login.title'), html`
    <h1>${t('login.title')}</h1>
    ${flash(msg, 'error')}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${next}">
      <label>${t('login.email')} <input type="email" name="email" value="${email}" required autocomplete="username" autofocus></label>
      <label>${t('login.password')} <input type="password" name="password" required autocomplete="current-password"></label>
      <button class="primary">${t('login.submit')}</button>
    </form>`);

  r.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    res.send(loginForm(req.t, safeNext(req.query.next)));
  });

  r.post('/login', (req, res) => {
    const { email = '', password = '', next } = req.body;
    if (tooMany(req.ip)) return res.status(429).send(loginForm(req.t, safeNext(next), req.t('login.tooMany'), email));
    const u = db.get('SELECT * FROM users WHERE email = ?', email.trim());
    if (!u || !verifyPassword(password, u.pw_hash)) {
      attempts.get(req.ip).push(Date.now());
      return res.status(401).send(loginForm(req.t, safeNext(next), req.t('login.wrong'), email));
    }
    const token = createSession(db, u.id);
    res.setHeader('Set-Cookie', sessionCookie(token, req.secure));
    res.redirect(safeNext(next));
  });

  r.post('/logout', (req, res) => {
    if (req.sessionToken) db.run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
    res.setHeader('Set-Cookie', sessionCookie(null, req.secure));
    res.redirect('/login');
  });

  const findInvite = (token) => db.get(`SELECT i.*, p.name AS podcast_name FROM invites i LEFT JOIN podcasts p ON p.id = i.podcast_id
    WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > ?`, token, new Date().toISOString());
  const invalid = (t) => plainPage(t, t('invite.title'), html`<h1>${t('invite.title')}</h1><p>${t('invite.invalid')}</p>`);

  r.get('/invite/:token', (req, res) => {
    const t = req.t;
    const inv = findInvite(req.params.token);
    if (!inv) return res.status(404).send(invalid(t));
    const existing = db.get('SELECT id FROM users WHERE email = ?', inv.email);
    res.send(plainPage(t, t('invite.title'), html`
      <h1>${t('invite.heading', { podcast: inv.podcast_name })}</h1>
      <p>${t('invite.for', { email: inv.email })}</p>
      <form method="post" class="stack">
        ${existing ? html`<p>${t('invite.existing')}</p>
          <label>${t('login.password')} <input type="password" name="password" required autocomplete="current-password"></label>`
        : html`<label>${t('invite.name')} <input name="name" required autocomplete="name"></label>
          <label>${t('invite.newPassword')} <input type="password" name="password" required minlength="10" autocomplete="new-password"></label>`}
        <button class="primary">${t('invite.accept')}</button>
      </form>`));
  });

  r.post('/invite/:token', (req, res) => {
    const t = req.t;
    const inv = findInvite(req.params.token);
    if (!inv) return res.status(404).send(invalid(t));
    const { name = '', password = '' } = req.body;
    let user = db.get('SELECT * FROM users WHERE email = ?', inv.email);
    if (user) {
      if (!verifyPassword(password, user.pw_hash)) return res.status(401).send(plainPage(t, t('invite.title'), html`<p>${t('login.wrong')} <a href="">${t('common.back')}</a></p>`));
    } else {
      if (password.length < 10 || !name.trim()) return res.status(400).send(plainPage(t, t('invite.title'), html`<p>${t('invite.needNamePassword')} <a href="">${t('common.back')}</a></p>`));
      // New users start with the language their browser is using
      const r2 = db.run('INSERT INTO users (name, email, pw_hash, locale) VALUES (?,?,?,?)', name.trim(), inv.email, hashPassword(password), isLocale(t.locale) ? t.locale : null);
      user = { id: Number(r2.lastInsertRowid), name: name.trim() };
    }
    db.tx(() => {
      if (inv.podcast_id) db.run('INSERT OR REPLACE INTO memberships (user_id, podcast_id, role) VALUES (?,?,?)', user.id, inv.podcast_id, inv.role);
      db.run('UPDATE invites SET used_at = ? WHERE token = ?', new Date().toISOString(), inv.token);
      logChange(db, { user, podcastId: inv.podcast_id, type: 'membership', id: user.id, key: 'log.joinedTeam', params: { name: user.name } });
    });
    const token = createSession(db, user.id);
    db.run('UPDATE sessions SET current_podcast_id = ? WHERE token = ?', inv.podcast_id, token);
    res.setHeader('Set-Cookie', sessionCookie(token, req.secure));
    res.redirect('/admin');
  });

  return r;
}
