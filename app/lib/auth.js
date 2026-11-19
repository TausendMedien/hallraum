import crypto from 'node:crypto';
import { translator, fromAcceptLanguage, isLocale } from './i18n.js';

const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function createSession(db, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  const first = db.get('SELECT podcast_id FROM memberships WHERE user_id = ? ORDER BY podcast_id LIMIT 1', userId);
  db.run('INSERT INTO sessions (token, user_id, current_podcast_id, expires_at) VALUES (?,?,?,?)', token, userId, first?.podcast_id, expires);
  return token;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, secure) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (secure) attrs.push('Secure');
  return `sid=${token || ''}; ${attrs.join('; ')}`;
}

// Loads user, memberships, current podcast and UI language into req
export function sessionMiddleware(db) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    req.user = null;
    if (token) {
      const s = db.get(`SELECT s.token, s.current_podcast_id, s.expires_at, u.id, u.name, u.email, u.is_superadmin, u.locale
                        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
      if (s && s.expires_at > new Date().toISOString()) {
        req.sessionToken = token;
        req.user = { id: s.id, name: s.name, email: s.email, isSuperadmin: !!s.is_superadmin, locale: s.locale };
        req.memberships = db.all(`SELECT m.role, p.id, p.slug, p.name FROM memberships m JOIN podcasts p ON p.id = m.podcast_id
                                  WHERE m.user_id = ? ORDER BY p.name`, s.id);
        if (req.user.isSuperadmin) {
          // The main admin sees all podcasts
          const all = db.all('SELECT id, slug, name FROM podcasts ORDER BY name');
          req.memberships = all.map((p) => ({ ...p, role: req.memberships.find((m) => m.id === p.id)?.role || 'admin' }));
        }
        req.podcast = req.memberships.find((m) => m.id === s.current_podcast_id) || req.memberships[0] || null;
      }
    }
    const locale = isLocale(req.user?.locale) ? req.user.locale : fromAcceptLanguage(req.headers['accept-language']);
    req.t = translator(locale);
    res.locals.user = req.user;
    next();
  };
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: req.t('err.notLoggedIn') });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// Checks that the user is a member of the podcast
export function canAccessPodcast(req, podcastId) {
  return !!req.memberships?.some((m) => m.id === podcastId);
}

export function isPodcastAdmin(req, podcastId) {
  return req.user?.isSuperadmin || req.memberships?.some((m) => m.id === podcastId && m.role === 'admin');
}

// Simple CSRF protection: state-changing requests must come from the same origin
export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path.startsWith('/api/worker/')) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next();
  try {
    const u = new URL(origin);
    if (u.host === req.headers.host) return next();
  } catch {}
  res.status(403).send(req.t('err.badOrigin'));
}
