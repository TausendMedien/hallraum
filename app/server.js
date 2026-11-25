import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { sessionMiddleware, sameOrigin } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import workerRoutes from './routes/worker.js';
import mediaRoutes from './routes/media.js';
import publicRoutes from './routes/public.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db = openDb()) {
  const app = express();
  app.set('db', db);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h', index: false }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(express.json({ limit: '20mb' }));
  app.use(sessionMiddleware(db));
  app.use(sameOrigin);

  app.use('/api/worker', workerRoutes(db));
  app.use(authRoutes(db));
  app.use('/admin', adminRoutes(db));
  app.use('/api', apiRoutes(db));
  app.use('/media', mediaRoutes(db));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api\nDisallow: /media\n'));
  app.use(publicRoutes(db));

  app.use((req, res) => res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><title>404</title><p style="font-family:sans-serif;padding:2rem">${req.t('err.pageNotFound')}</p>`));
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500 && !err.expose) console.error(err);
    if (res.headersSent) return;
    const t = req.t || ((k) => k);
    const msg = status >= 500 && !err.expose ? t('err.internal') : err.i18n ? t(err.i18n.key, err.i18n.params) : err.message;
    if (req.originalUrl.startsWith('/api/') || req.headers['x-requested-with'] === 'fetch' || req.accepts(['html', 'json']) === 'json') return res.status(status).json({ error: msg });
    res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:2rem">${t('err.prefix')} ${String(msg).replace(/</g, '&lt;')}</p>`);
  });
  return app;
}

// Started directly (locally, in Docker or via Passenger)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) || process.env.PASSENGER_APP_ENV) {
  const port = Number(process.env.PORT || 3000);
  // Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing
  createApp().listen(port, (err) => {
    if (err) {
      console.error(`Hallraum could not start on port ${port}: ${err.code === 'EADDRINUSE' ? 'the port is already in use. Set another one with PORT=… in .env' : err.message}`);
      process.exit(1);
    }
    console.log(`Hallraum is running on http://localhost:${port}`);
  });
}
