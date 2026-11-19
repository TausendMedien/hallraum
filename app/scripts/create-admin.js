// Create the main admin (or reset the password) and optionally the first podcast.
// Usage: npm run admin -- --name "Anna" --email anna@example.org [--podcast "My Podcast" --slug my-podcast --language en]
// The password is asked interactively (or taken from the ADMIN_PASSWORD environment variable).
import readline from 'node:readline/promises';
import { openDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { slugify } from '../lib/html.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.email || !args.name) {
  console.log('Usage: npm run admin -- --name "Anna" --email anna@example.org [--podcast "My Podcast" --slug my-podcast --language en]');
  process.exit(1);
}

let pw = process.env.ADMIN_PASSWORD;
if (!pw) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  pw = await rl.question('Password (at least 10 characters): ');
  rl.close();
}
if (!pw || pw.length < 10) { console.error('Password too short.'); process.exit(1); }

const db = openDb();
const existing = db.get('SELECT id FROM users WHERE email = ?', args.email);
let userId;
if (existing) {
  db.run('UPDATE users SET name = ?, pw_hash = ?, is_superadmin = 1 WHERE id = ?', args.name, hashPassword(pw), existing.id);
  userId = existing.id;
  console.log(`Account ${args.email} updated (main admin).`);
} else {
  userId = Number(db.run('INSERT INTO users (name, email, pw_hash, is_superadmin) VALUES (?,?,?,1)', args.name, args.email, hashPassword(pw)).lastInsertRowid);
  console.log(`Main admin ${args.email} created.`);
}

if (args.podcast) {
  const slug = slugify(args.slug || args.podcast);
  let p = db.get('SELECT id FROM podcasts WHERE slug = ?', slug);
  if (!p) {
    const id = Number(db.run(`INSERT INTO podcasts (name, slug, subtitle, author, language, explicit) VALUES (?,?,?,?,?, 0)`,
      args.podcast, slug, args.subtitle || '', args.name, args.language === 'de' ? 'de' : 'en').lastInsertRowid);
    db.run('INSERT INTO seasons (podcast_id, number) VALUES (?, 1)', id);
    p = { id };
    console.log(`Podcast "${args.podcast}" created at /${slug}.`);
  }
  db.run('INSERT OR REPLACE INTO memberships (user_id, podcast_id, role) VALUES (?,?,?)', userId, p.id, 'admin');
}
db.close();
