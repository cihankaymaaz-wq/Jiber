// =====================================================================
//  JİBER Saha Denetim ve Kalite Portalı — sunucu (Vercel Function)
//  Tüm işlemler tek uç noktadan: /api?a=<işlem>
//  Veritabanı: Vercel Storage › Neon Postgres (DATABASE_URL otomatik gelir)
// =====================================================================
import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
const BOOTSTRAP_EMAIL = 'cihankaymaaz@gmail.com';
const BOOTSTRAP_PASSWORD = '212121';
const SESSION_DAYS = 30;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = m => new HttpError(400, m);

// ---------------------------------------------------------------------
//  Veritabanı
// ---------------------------------------------------------------------
let pool;
function db() {
  if (!pool) {
    const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!cs) throw new HttpError(500, 'Veritabanı bağlı değil. Vercel › Storage bölümünden Postgres (Neon) veritabanını projeye bağlayın ve yeniden yayınlayın.');
    pool = new Pool({ connectionString: cs, max: 3, idleTimeoutMillis: 10000 });
  }
  return pool;
}
const q = (text, params) => db().query(text, params);
async function tx(fn) {
  const c = await db().connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  photo_required boolean NOT NULL DEFAULT true,
  action_on_no boolean NOT NULL DEFAULT true,
  max_distance int NOT NULL DEFAULT 300,
  block_outside boolean NOT NULL DEFAULT false,
  max_accuracy int NOT NULL DEFAULT 100,
  secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  pass_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','auditor')),
  active boolean NOT NULL DEFAULT true,
  pv int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stores (
  id serial PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  lat double precision,
  lng double precision,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_stores (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id int NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  sort int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS questions (
  id serial PRIMARY KEY,
  text text NOT NULL,
  category_id int NOT NULL REFERENCES categories(id),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
CREATE SEQUENCE IF NOT EXISTS report_seq;
CREATE TABLE IF NOT EXISTS audits (
  id uuid PRIMARY KEY,
  auditor_id int REFERENCES users(id) ON DELETE SET NULL,
  auditor_name text NOT NULL,
  store_id int REFERENCES stores(id) ON DELETE SET NULL,
  store_name text NOT NULL,
  store_region text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  report_seq int UNIQUE,
  questions jsonb NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  loc_lat double precision, loc_lng double precision, loc_acc double precision, loc_time timestamptz,
  store_lat double precision, store_lng double precision,
  distance_m double precision,
  gps_verified boolean,
  result text, yes_count int, no_count int,
  action_status text, action_note text, action_by text, action_at timestamptz
);
CREATE INDEX IF NOT EXISTS audits_auditor_idx ON audits(auditor_id);
CREATE INDEX IF NOT EXISTS audits_completed_idx ON audits(completed_at DESC);
CREATE TABLE IF NOT EXISTS photos (
  id uuid PRIMARY KEY,
  audit_id uuid NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  uploader_id int,
  mime text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_audit_idx ON photos(audit_id);
CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS login_fail (
  email text PRIMARY KEY,
  cnt int NOT NULL DEFAULT 0,
  last_at timestamptz NOT NULL DEFAULT now()
);`;

let ready = null, SECRET = null;
function init() {
  if (!ready) {
    ready = (async () => {
      const c = await db().connect();
      try {
        await c.query('SELECT pg_advisory_lock(7342001)');
        await c.query(SCHEMA);
        await c.query(`INSERT INTO app_settings (id, secret) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [crypto.randomBytes(48).toString('base64url')]);
        const u = await c.query('SELECT count(*)::int AS n FROM users');
        if (u.rows[0].n === 0) {
          await c.query(`INSERT INTO users (name, email, pass_hash, role) VALUES ($1, $2, $3, 'admin')`,
            ['Ana Yönetici', BOOTSTRAP_EMAIL, await hashPassword(BOOTSTRAP_PASSWORD)]);
        }
        SECRET = (await c.query('SELECT secret FROM app_settings WHERE id = 1')).rows[0].secret;
      } finally {
        await c.query('SELECT pg_advisory_unlock(7342001)').catch(() => {});
        c.release();
      }
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

// ---------------------------------------------------------------------
//  Şifre ve oturum
// ---------------------------------------------------------------------
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [v, s, h] = String(stored || '').split('$');
  if (v !== 's1' || !s || !h) { await scrypt(pw, 'dummy-salt-value'); return false; }
  const k = await scrypt(pw, Buffer.from(s, 'base64'));
  const hb = Buffer.from(h, 'base64');
  return hb.length === k.length && crypto.timingSafeEqual(hb, k);
}
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function makeToken(u) {
  const payload = Buffer.from(JSON.stringify({ u: u.id, pv: u.pv, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function readToken(t) {
  const [p, s] = String(t || '').split('.');
  if (!p || !s) return null;
  const exp = Buffer.from(sign(p)), got = Buffer.from(s);
  if (exp.length !== got.length || !crypto.timingSafeEqual(exp, got)) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); });
  return out;
}
const isHttps = req => (req.headers['x-forwarded-proto'] || '').includes('https');
function setSession(req, res, u) {
  res.setHeader('Set-Cookie', `jds=${makeToken(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}
function clearSession(req, res) {
  res.setHeader('Set-Cookie', `jds=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
}
async function currentUser(req) {
  const t = readToken(parseCookies(req).jds);
  if (!t) return null;
  const r = await q(`SELECT u.id, u.name, u.email, u.role, u.active, u.pv,
      COALESCE(array_agg(us.store_id) FILTER (WHERE us.store_id IS NOT NULL), '{}') AS store_ids
    FROM users u LEFT JOIN user_stores us ON us.user_id = u.id WHERE u.id = $1 GROUP BY u.id`, [t.u]);
  const u = r.rows[0];
  if (!u || !u.active || u.pv !== t.pv) return null;
  u.storeIds = u.store_ids.map(Number);
  return u;
}
const publicUser = u => ({ id: String(u.id), name: u.name, email: u.email, role: u.role, storeIds: u.storeIds.map(String) });
const isAdmin = u => u.role === 'admin';
const canStore = (u, sid) => isAdmin(u) || u.storeIds.includes(Number(sid));

// ---------------------------------------------------------------------
//  E-posta (Gmail SMTP veya Resend) — isteğe bağlı
// ---------------------------------------------------------------------
const mailConfigured = () => !!(process.env.RESEND_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS));
async function sendMail(to, subject, text, html) {
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'JİBER Denetim <onboarding@resend.dev>', to: [to], subject, text, html })
    });
    if (!r.ok) throw new Error('Resend: ' + (await r.text()).slice(0, 200));
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(process.env.SMTP_PORT || 465);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') }
  });
  await t.sendMail({ from: process.env.MAIL_FROM || `JİBER Denetim <${process.env.SMTP_USER}>`, to, subject, text, html });
}
function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}
async function sendResetMail(req, user) {
  const recent = await q(`SELECT 1 FROM reset_tokens WHERE user_id = $1 AND created_at > now() - interval '60 seconds'`, [user.id]);
  if (recent.rowCount) return;
  const token = crypto.randomBytes(32).toString('base64url');
  const th = crypto.createHash('sha256').update(token).digest('hex');
  await q(`INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [th, user.id]);
  const link = `${originOf(req)}/?sifre=${token}`;
  const text = `Merhaba ${user.name},\n\nJİBER Saha Denetim Portalı şifrenizi sıfırlamak için aşağıdaki bağlantıyı açın (1 saat geçerlidir):\n${link}\n\nBu isteği siz yapmadıysanız bu e-postayı dikkate almayın.`;
  const html = `<p>Merhaba ${escHtml(user.name)},</p><p>JİBER Saha Denetim Portalı şifrenizi sıfırlamak için aşağıdaki düğmeye tıklayın. Bağlantı <b>1 saat</b> geçerlidir.</p>
    <p><a href="${link}" style="display:inline-block;background:#e63946;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Yeni şifre belirle</a></p>
    <p style="color:#666;font-size:13px">Bu isteği siz yapmadıysanız bu e-postayı dikkate almayın.</p>`;
  await sendMail(user.email, 'JİBER Denetim Portalı — Şifre sıfırlama', text, html);
}
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------
//  Doğrulama yardımcıları
// ---------------------------------------------------------------------
const str = (v, max, name, required = false) => {
  const s = typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  if (required && !s) throw bad(`${name} boş olamaz.`);
  if (s.length > max) throw bad(`${name} en fazla ${max} karakter olabilir.`);
  return s;
};
const intId = (v, name = 'Kayıt') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad(`${name} geçersiz.`); return n; };
const uuidOk = v => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const ms = d => d ? new Date(d).getTime() : null;
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
async function getSettings(c = null) {
  const r = await (c || db()).query('SELECT * FROM app_settings WHERE id = 1');
  const s = r.rows[0];
  return { photoRequiredOnNo: s.photo_required, actionOnNo: s.action_on_no, maxDistanceM: s.max_distance, blockOutside: s.block_outside, maxAccuracyM: s.max_accuracy };
}

// Cevapları temizle: yalnızca denetimdeki sorular, makul uzunluklar
function cleanAnswers(raw, questionIds) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const qid of questionIds) {
    const a = raw[qid];
    if (!a || typeof a !== 'object') continue;
    if (a.a !== 'yes' && a.a !== 'no') continue;
    if (a.a === 'yes') { out[qid] = { a: 'yes' }; continue; }
    out[qid] = {
      a: 'no',
      note: str(a.note, 3000, 'Açıklama'),
      action: str(a.action, 500, 'Aksiyon'),
      due: typeof a.due === 'string' && dateOk(a.due) ? a.due : '',
      photos: Array.isArray(a.photos) ? a.photos.filter(uuidOk).slice(0, 10) : []
    };
  }
  return out;
}

function auditSummary(r) {
  return {
    id: r.id, auditorId: r.auditor_id == null ? null : String(r.auditor_id), auditorName: r.auditor_name,
    storeId: r.store_id == null ? null : String(r.store_id), storeName: r.store_name, storeRegion: r.store_region,
    status: r.status, startedAt: ms(r.started_at), updatedAt: ms(r.updated_at), completedAt: ms(r.completed_at),
    reportSeq: r.report_seq, result: r.result, yesCount: r.yes_count, noCount: r.no_count,
    gpsVerified: r.gps_verified, actionStatus: r.action_status,
    questionCount: r.qn, answeredCount: r.an
  };
}
const SUMMARY_COLS = `id, auditor_id, auditor_name, store_id, store_name, store_region, status, started_at, updated_at, completed_at,
  report_seq, result, yes_count, no_count, gps_verified, action_status,
  jsonb_array_length(questions) AS qn,
  (SELECT count(*)::int FROM jsonb_each(answers) e WHERE e.value->>'a' IS NOT NULL) AS an`;

async function loadAudit(id, user, { forUpdate = false, client = null } = {}) {
  if (!uuidOk(id)) throw new HttpError(404, 'Denetim bulunamadı.');
  const r = await (client || db()).query(`SELECT * FROM audits WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const a = r.rows[0];
  if (!a) throw new HttpError(404, 'Denetim bulunamadı.');
  if (!isAdmin(user) && a.auditor_id !== user.id) throw new HttpError(403, 'Bu denetime / rapora erişim yetkiniz yok.');
  return a;
}
function ownDraft(a, user) {
  if (a.auditor_id !== user.id) throw new HttpError(403, 'Bu taslak başka bir denetçiye ait.');
  if (a.status !== 'draft') throw bad('Bu denetim tamamlanmış; değiştirilemez.');
}

// ---------------------------------------------------------------------
//  İşlemler
// ---------------------------------------------------------------------
const R = {};
const route = (name, opts, fn) => { R[name] = { ...opts, fn }; };

// ---- Oturum ----
route('me', { auth: false, method: 'GET' }, async ({ req }) => {
  const u = await currentUser(req);
  return { user: u ? publicUser(u) : null, mail: mailConfigured() };
});

route('login', { auth: false, method: 'POST' }, async ({ req, res, body }) => {
  const email = str(body.email, 200, 'E-posta').toLowerCase();
  const pw = String(body.password || '');
  if (!email || !pw) throw bad('E-posta ve şifre girin.');
  const f = (await q(`SELECT cnt, last_at > now() - interval '15 minutes' AS recent FROM login_fail WHERE email = $1`, [email])).rows[0];
  if (f && f.recent && f.cnt >= 8) throw new HttpError(429, 'Çok fazla hatalı deneme yapıldı. 15 dakika sonra tekrar deneyin veya "Şifremi Unuttum"u kullanın.');
  const u = (await q('SELECT * FROM users WHERE email = $1', [email])).rows[0];
  const ok = await verifyPassword(pw, u?.pass_hash);
  if (!u || !ok) {
    await q(`INSERT INTO login_fail (email, cnt, last_at) VALUES ($1, 1, now())
      ON CONFLICT (email) DO UPDATE SET cnt = CASE WHEN login_fail.last_at > now() - interval '15 minutes' THEN login_fail.cnt + 1 ELSE 1 END, last_at = now()`, [email]);
    throw new HttpError(401, 'E-posta veya şifre hatalı.');
  }
  if (!u.active) throw new HttpError(403, 'Hesabınız pasif durumda. Yöneticinize başvurun.');
  await q('DELETE FROM login_fail WHERE email = $1', [email]);
  setSession(req, res, u);
  const full = await currentUser({ headers: { cookie: 'jds=' + encodeURIComponent(makeToken(u)) } });
  return { user: publicUser(full) };
});

route('logout', { auth: false, method: 'POST' }, async ({ req, res }) => { clearSession(req, res); return {}; });

route('forgot', { auth: false, method: 'POST' }, async ({ req, body }) => {
  const email = str(body.email, 200, 'E-posta').toLowerCase();
  if (!emailOk(email)) throw bad('Geçerli bir e-posta adresi girin.');
  if (!mailConfigured()) throw new HttpError(503, 'E-posta servisi henüz kurulmamış. Yöneticinizden şifrenizi sıfırlamasını isteyin.');
  const u = (await q('SELECT id, name, email FROM users WHERE email = $1 AND active', [email])).rows[0];
  if (u) {
    try { await sendResetMail(req, u); }
    catch (e) { console.error(e); throw new HttpError(502, 'E-posta gönderilemedi. Lütfen daha sonra tekrar deneyin veya yöneticinize başvurun.'); }
  }
  return {};
});

async function tokenUser(token) {
  if (typeof token !== 'string' || token.length < 20) throw bad('Sıfırlama bağlantısı geçersiz.');
  const th = crypto.createHash('sha256').update(token).digest('hex');
  const r = (await q(`SELECT t.*, u.email, u.active FROM reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`, [th])).rows[0];
  if (!r || r.used || !r.active) throw bad('Sıfırlama bağlantısı geçersiz veya daha önce kullanılmış.');
  if (new Date(r.expires_at) < new Date()) throw bad('Sıfırlama bağlantısının süresi dolmuş. Yeni bağlantı isteyin.');
  return { ...r, th };
}
route('resetcheck', { auth: false, method: 'GET' }, async ({ query }) => ({ email: (await tokenUser(query.token)).email }));
route('reset', { auth: false, method: 'POST' }, async ({ body }) => {
  const t = await tokenUser(body.token);
  const pw = String(body.password || '');
  if (pw.length < 6) throw bad('Şifre en az 6 karakter olmalı.');
  await tx(async c => {
    await c.query('UPDATE users SET pass_hash = $1, pv = pv + 1, updated_at = now() WHERE id = $2', [await hashPassword(pw), t.user_id]);
    await c.query('UPDATE reset_tokens SET used = true WHERE user_id = $1', [t.user_id]);
  });
  await q('DELETE FROM login_fail WHERE email = $1', [t.email]);
  return {};
});

route('changepw', { method: 'POST' }, async ({ req, res, body, user }) => {
  const u = (await q('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
  if (!(await verifyPassword(String(body.current || ''), u.pass_hash))) throw bad('Mevcut şifre hatalı.');
  const pw = String(body.password || '');
  if (pw.length < 6) throw bad('Yeni şifre en az 6 karakter olmalı.');
  const r = await q('UPDATE users SET pass_hash = $1, pv = pv + 1, updated_at = now() WHERE id = $2 RETURNING *', [await hashPassword(pw), user.id]);
  setSession(req, res, r.rows[0]);
  return {};
});

// ---- Tüm ekran verisi ----
route('data', { method: 'GET' }, async ({ user }) => {
  const admin = isAdmin(user);
  const [settings, cats, qs, stores, users, audits] = await Promise.all([
    getSettings(),
    q('SELECT id::text, name, sort FROM categories ORDER BY sort, id'),
    q(`SELECT id::text, text, category_id::text AS "categoryId", sort, active FROM questions ${admin ? '' : 'WHERE active'} ORDER BY sort, id`),
    admin ? q('SELECT id::text, name, code, region, address, lat, lng, active FROM stores ORDER BY region, name')
          : q('SELECT id::text, name, code, region, address, lat, lng, active FROM stores WHERE id = ANY($1::int[]) ORDER BY region, name', [user.storeIds]),
    admin ? q(`SELECT u.id::text, u.name, u.email, u.role, u.active,
                 COALESCE(array_agg(us.store_id::text) FILTER (WHERE us.store_id IS NOT NULL), '{}') AS "storeIds"
               FROM users u LEFT JOIN user_stores us ON us.user_id = u.id GROUP BY u.id ORDER BY u.name`) : { rows: [] },
    admin ? q(`SELECT ${SUMMARY_COLS} FROM audits WHERE status = 'completed' OR auditor_id = $1 ORDER BY completed_at DESC NULLS LAST LIMIT 5000`, [user.id])
          : q(`SELECT ${SUMMARY_COLS} FROM audits WHERE auditor_id = $1 ORDER BY completed_at DESC NULLS LAST`, [user.id])
  ]);
  return {
    user: publicUser(user), settings,
    categories: cats.rows, questions: qs.rows, stores: stores.rows, users: users.rows,
    audits: audits.rows.map(auditSummary), mail: mailConfigured()
  };
});

// ---- Denetim ----
route('audit', { method: 'GET' }, async ({ query, user }) => {
  const a = await loadAudit(query.id, user);
  const photos = await q('SELECT id, question_id AS qid FROM photos WHERE audit_id = $1 ORDER BY created_at', [a.id]);
  return {
    audit: {
      ...auditSummary({ ...a, qn: a.questions.length, an: Object.values(a.answers).filter(x => x?.a).length }),
      questions: a.questions, answers: a.answers,
      location: a.loc_lat == null ? null : { lat: a.loc_lat, lng: a.loc_lng, accuracy: a.loc_acc, capturedAt: ms(a.loc_time) },
      storeLat: a.store_lat, storeLng: a.store_lng, distanceM: a.distance_m,
      actionNote: a.action_note, actionBy: a.action_by, actionAt: ms(a.action_at),
      photos: photos.rows
    }
  };
});

route('audit_start', { method: 'POST' }, async ({ body, user }) => {
  const sid = intId(body.storeId, 'Mağaza');
  if (!canStore(user, sid)) throw new HttpError(403, 'Bu mağazada denetim yetkiniz yok.');
  const st = (await q('SELECT * FROM stores WHERE id = $1', [sid])).rows[0];
  if (!st) throw bad('Mağaza bulunamadı.');
  if (!st.active) throw bad('Bu mağaza pasif durumda.');
  const qs = (await q(`SELECT q.id::text AS id, q.text, q.category_id::text AS "categoryId", c.name AS "categoryName"
      FROM questions q JOIN categories c ON c.id = q.category_id WHERE q.active ORDER BY c.sort, c.id, q.sort, q.id`)).rows;
  if (!qs.length) throw bad('Aktif denetim sorusu yok. Yöneticinin soru eklemesi gerekiyor.');
  const id = crypto.randomUUID();
  await q(`INSERT INTO audits (id, auditor_id, auditor_name, store_id, store_name, store_region, questions)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, user.id, user.name, sid, st.name, st.region, JSON.stringify(qs)]);
  return { id };
});

route('audit_save', { method: 'POST' }, async ({ body, user }) => {
  const a = await loadAudit(body.id, user);
  ownDraft(a, user);
  const answers = cleanAnswers(body.answers, a.questions.map(x => x.id));
  const r = await q(`UPDATE audits SET answers = $1, updated_at = now() WHERE id = $2 AND status = 'draft' RETURNING updated_at`, [JSON.stringify(answers), a.id]);
  if (!r.rowCount) throw bad('Bu denetim tamamlanmış; değiştirilemez.');
  return { savedAt: ms(r.rows[0].updated_at) };
});

route('photo_add', { method: 'POST' }, async ({ body, user }) => {
  const a = await loadAudit(body.auditId, user);
  ownDraft(a, user);
  const qid = String(body.qid || '');
  if (!a.questions.some(x => x.id === qid)) throw bad('Soru bulunamadı.');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
  if (!m) throw bad('Fotoğraf biçimi geçersiz.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw bad('Fotoğraf çok büyük.');
  const n = (await q('SELECT count(*)::int AS n FROM photos WHERE audit_id = $1 AND question_id = $2', [a.id, qid])).rows[0].n;
  if (n >= 10) throw bad('Bir soruya en fazla 10 fotoğraf eklenebilir.');
  const id = crypto.randomUUID();
  await q('INSERT INTO photos (id, audit_id, question_id, uploader_id, mime, data) VALUES ($1, $2, $3, $4, $5, $6)', [id, a.id, qid, user.id, m[1], buf]);
  return { id };
});

route('photo_del', { method: 'POST' }, async ({ body, user }) => {
  if (!uuidOk(body.id)) throw bad('Fotoğraf bulunamadı.');
  const p = (await q('SELECT audit_id FROM photos WHERE id = $1', [body.id])).rows[0];
  if (!p) return {};
  const a = await loadAudit(p.audit_id, user);
  ownDraft(a, user);
  await q('DELETE FROM photos WHERE id = $1', [body.id]);
  return {};
});

route('photo', { method: 'GET', raw: true }, async ({ query, user, res }) => {
  if (!uuidOk(query.id)) throw new HttpError(404, 'Fotoğraf bulunamadı.');
  const p = (await q('SELECT p.mime, p.data, a.auditor_id FROM photos p JOIN audits a ON a.id = p.audit_id WHERE p.id = $1', [query.id])).rows[0];
  if (!p) throw new HttpError(404, 'Fotoğraf bulunamadı.');
  if (!isAdmin(user) && p.auditor_id !== user.id) throw new HttpError(403, 'Bu fotoğrafa erişim yetkiniz yok.');
  res.statusCode = 200;
  res.setHeader('Content-Type', p.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(p.data);
});

route('audit_complete', { method: 'POST' }, async ({ body, user }) => {
  const loc = body.location || {};
  const lat = Number(loc.lat), lng = Number(loc.lng), acc = Number(loc.accuracy), cap = Number(loc.capturedAt);
  if (![lat, lng, acc].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || acc < 0)
    throw bad('Konum bilgisi alınamadı. Denetim konum olmadan tamamlanamaz.');
  return tx(async c => {
    const a = await loadAudit(body.id, user, { forUpdate: true, client: c });
    ownDraft(a, user);
    if (!canStore(user, a.store_id)) throw new HttpError(403, 'Bu mağazadaki denetim yetkiniz kaldırılmış.');
    const cfg = await getSettings(c);
    const answers = cleanAnswers(body.answers, a.questions.map(x => x.id));
    const ph = (await c.query('SELECT id::text, question_id FROM photos WHERE audit_id = $1', [a.id])).rows;
    const missing = [];
    let no = 0;
    for (const qq of a.questions) {
      const an = answers[qq.id];
      if (!an) { missing.push(`"${qq.text}" cevaplanmadı`); continue; }
      if (an.a === 'no') {
        no++;
        an.photos = ph.filter(p => p.question_id === qq.id).map(p => p.id);
        if (cfg.photoRequiredOnNo && !an.photos.length) missing.push(`"${qq.text}" için fotoğraf eksik`);
        if (cfg.actionOnNo && !an.due) missing.push(`"${qq.text}" için termin eksik`);
        if (!cfg.actionOnNo) { delete an.action; delete an.due; }
      }
    }
    if (missing.length) throw bad(`${missing.length} eksik var: ${missing.slice(0, 3).join('; ')}${missing.length > 3 ? '…' : ''}`);
    const st = a.store_id ? (await c.query('SELECT lat, lng FROM stores WHERE id = $1', [a.store_id])).rows[0] : null;
    const hasCoord = st && st.lat != null && st.lng != null;
    const dist = hasCoord ? haversine(lat, lng, st.lat, st.lng) : null;
    const within = hasCoord && dist <= cfg.maxDistanceM;
    if (cfg.blockOutside && !within)
      throw bad(hasCoord ? `Mağazaya uzaklığınız ${Math.round(dist)} m (izin verilen ${cfg.maxDistanceM} m). Bu konumdan denetim tamamlanamaz.`
                         : 'Mağazanın kayıtlı koordinatı yok; mesafe sınırı zorunlu olduğundan denetim tamamlanamaz. Yöneticiye bildirin.');
    const verified = !!(hasCoord && within && acc <= cfg.maxAccuracyM);
    const keep = Object.values(answers).flatMap(x => x.photos || []);
    await c.query('DELETE FROM photos WHERE audit_id = $1 AND NOT (id::text = ANY($2::text[]))', [a.id, keep]);
    const result = no ? 'aksiyon' : 'uygun';
    const capTime = Number.isFinite(cap) && cap > 0 ? new Date(cap) : null;
    const r = await c.query(`UPDATE audits SET answers = $2, status = 'completed', completed_at = now(), updated_at = now(),
        report_seq = nextval('report_seq'), loc_lat = $3, loc_lng = $4, loc_acc = $5, loc_time = $6,
        store_lat = $7, store_lng = $8, distance_m = $9, gps_verified = $10, result = $11, no_count = $12, yes_count = $13,
        action_status = $14
      WHERE id = $1 RETURNING report_seq`,
      [a.id, JSON.stringify(answers), lat, lng, acc, capTime, st?.lat ?? null, st?.lng ?? null, dist == null ? null : Math.round(dist * 10) / 10,
       verified, result, no, a.questions.length - no, result === 'aksiyon' ? 'acik' : 'yok']);
    return { reportSeq: r.rows[0].report_seq, gpsVerified: verified, distanceM: dist };
  });
});

route('audit_delete', { method: 'POST' }, async ({ body, user }) => {
  const a = await loadAudit(body.id, user);
  if (a.status !== 'draft') throw bad('Tamamlanmış denetimler silinemez.');
  if (a.auditor_id !== user.id && !isAdmin(user)) throw new HttpError(403, 'Bu taslağı silme yetkiniz yok.');
  await q('DELETE FROM audits WHERE id = $1', [a.id]);
  return {};
});

route('action_set', { method: 'POST', admin: true }, async ({ body, user }) => {
  const a = await loadAudit(body.id, user);
  if (a.status !== 'completed' || a.result !== 'aksiyon') throw bad('Bu raporda aksiyon yok.');
  const status = body.status === 'kapandi' ? 'kapandi' : 'acik';
  await q('UPDATE audits SET action_status = $2, action_note = $3, action_by = $4, action_at = now() WHERE id = $1',
    [a.id, status, str(body.note, 2000, 'Not'), user.name]);
  return {};
});

// ---- Kullanıcılar ----
route('user_save', { method: 'POST', admin: true }, async ({ body, user }) => {
  const id = body.id ? intId(body.id, 'Kullanıcı') : null;
  const self = id === user.id;
  const name = str(body.name, 120, 'Ad soyad', true);
  const email = str(body.email, 200, 'E-posta', true).toLowerCase();
  if (!emailOk(email)) throw bad('Geçerli bir e-posta adresi girin.');
  const role = self ? 'admin' : (body.role === 'admin' ? 'admin' : 'auditor');
  const active = self ? true : body.active !== false;
  const pw = body.password ? String(body.password) : '';
  if (!id && pw.length < 6) throw bad('İlk şifre en az 6 karakter olmalı.');
  if (pw && pw.length < 6) throw bad('Şifre en az 6 karakter olmalı.');
  const storeIds = role === 'admin' ? [] : (Array.isArray(body.storeIds) ? body.storeIds.map(Number).filter(Number.isInteger) : []);
  try {
    return await tx(async c => {
      let uid = id;
      if (!id) {
        uid = (await c.query(`INSERT INTO users (name, email, pass_hash, role, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [name, email, await hashPassword(pw), role, active])).rows[0].id;
      } else {
        const r = await c.query(`UPDATE users SET name = $2, email = $3, role = $4, active = $5, updated_at = now()
          ${pw ? ', pass_hash = $6, pv = pv + 1' : ''} WHERE id = $1`, pw ? [id, name, email, role, active, await hashPassword(pw)] : [id, name, email, role, active]);
        if (!r.rowCount) throw new HttpError(404, 'Kullanıcı bulunamadı.');
      }
      await c.query('DELETE FROM user_stores WHERE user_id = $1', [uid]);
      if (storeIds.length) await c.query('INSERT INTO user_stores (user_id, store_id) SELECT $1, s.id FROM stores s WHERE s.id = ANY($2::int[])', [uid, storeIds]);
      return { id: String(uid) };
    });
  } catch (e) {
    if (e.code === '23505') throw bad('Bu e-posta adresiyle kayıtlı başka bir kullanıcı var.');
    throw e;
  }
});
route('user_delete', { method: 'POST', admin: true }, async ({ body, user }) => {
  const id = intId(body.id, 'Kullanıcı');
  if (id === user.id) throw bad('Kendi hesabınızı silemezsiniz.');
  await q('DELETE FROM users WHERE id = $1', [id]);
  return {};
});
route('user_reset', { method: 'POST', admin: true }, async ({ req, body }) => {
  if (!mailConfigured()) throw new HttpError(503, 'E-posta servisi kurulmamış. Kullanıcıyı düzenleyip yeni şifre belirleyebilirsiniz.');
  const u = (await q('SELECT id, name, email FROM users WHERE id = $1', [intId(body.id, 'Kullanıcı')])).rows[0];
  if (!u) throw new HttpError(404, 'Kullanıcı bulunamadı.');
  await q('DELETE FROM reset_tokens WHERE user_id = $1 AND created_at > now() - interval \'60 seconds\'', [u.id]);
  try { await sendResetMail(req, u); } catch (e) { console.error(e); throw new HttpError(502, 'E-posta gönderilemedi: ' + e.message); }
  return {};
});

// ---- Mağazalar ----
route('store_save', { method: 'POST', admin: true }, async ({ body }) => {
  const id = body.id ? intId(body.id, 'Mağaza') : null;
  const name = str(body.name, 150, 'Mağaza adı', true);
  const lat = body.lat === null || body.lat === '' || body.lat === undefined ? null : Number(body.lat);
  const lng = body.lng === null || body.lng === '' || body.lng === undefined ? null : Number(body.lng);
  if ((lat == null) !== (lng == null)) throw bad('Enlem ve boylamın ikisini birden girin.');
  if (lat != null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw bad('Koordinat geçersiz.');
  const vals = [name, str(body.code, 50, 'Kod'), str(body.region, 100, 'Bölge'), str(body.address, 300, 'Adres'), lat, lng, body.active !== false];
  if (id) {
    const r = await q('UPDATE stores SET name=$1, code=$2, region=$3, address=$4, lat=$5, lng=$6, active=$7, updated_at=now() WHERE id=$8', [...vals, id]);
    if (!r.rowCount) throw new HttpError(404, 'Mağaza bulunamadı.');
    return { id: String(id) };
  }
  return { id: String((await q('INSERT INTO stores (name, code, region, address, lat, lng, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', vals)).rows[0].id) };
});
route('store_delete', { method: 'POST', admin: true }, async ({ body }) => { await q('DELETE FROM stores WHERE id = $1', [intId(body.id, 'Mağaza')]); return {}; });
route('region_rename', { method: 'POST', admin: true }, async ({ body }) => {
  const from = str(body.from, 100, 'Bölge', true), to = str(body.to, 100, 'Yeni bölge adı', true);
  await q('UPDATE stores SET region = $2, updated_at = now() WHERE region = $1', [from, to]);
  return {};
});

// ---- Kategoriler ve sorular ----
async function move(table, id, dir, where = '', params = []) {
  return tx(async c => {
    const rows = (await c.query(`SELECT id FROM ${table} ${where} ORDER BY sort, id`, params)).rows.map(r => r.id);
    const i = rows.indexOf(id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= rows.length) return {};
    [rows[i], rows[j]] = [rows[j], rows[i]];
    for (let k = 0; k < rows.length; k++) await c.query(`UPDATE ${table} SET sort = $1 WHERE id = $2`, [k + 1, rows[k]]);
    return {};
  });
}
route('cat_save', { method: 'POST', admin: true }, async ({ body }) => {
  const name = str(body.name, 100, 'Kategori adı', true);
  if (body.id) { await q('UPDATE categories SET name = $1 WHERE id = $2', [name, intId(body.id)]); return {}; }
  await q('INSERT INTO categories (name, sort) SELECT $1, COALESCE(max(sort), 0) + 1 FROM categories', [name]);
  return {};
});
route('cat_delete', { method: 'POST', admin: true }, async ({ body }) => {
  const id = intId(body.id);
  const n = (await q('SELECT count(*)::int AS n FROM questions WHERE category_id = $1', [id])).rows[0].n;
  if (n) throw bad('Bu kategoride soru var. Önce soruları silin veya başka kategoriye taşıyın.');
  await q('DELETE FROM categories WHERE id = $1', [id]);
  return {};
});
route('cat_move', { method: 'POST', admin: true }, async ({ body }) => move('categories', intId(body.id), Number(body.dir)));
route('q_save', { method: 'POST', admin: true }, async ({ body }) => {
  const text = str(body.text, 500, 'Soru metni', true);
  const cat = intId(body.categoryId, 'Kategori');
  const active = body.active !== false;
  if (body.id) {
    const id = intId(body.id);
    const cur = (await q('SELECT category_id FROM questions WHERE id = $1', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'Soru bulunamadı.');
    if (cur.category_id !== cat)
      await q('UPDATE questions SET text=$1, category_id=$2, active=$3, sort=(SELECT COALESCE(max(sort),0)+1 FROM questions WHERE category_id=$2) WHERE id=$4', [text, cat, active, id]);
    else await q('UPDATE questions SET text=$1, active=$2 WHERE id=$3', [text, active, id]);
    return {};
  }
  await q('INSERT INTO questions (text, category_id, active, sort) SELECT $1, $2, $3, COALESCE(max(sort),0)+1 FROM questions WHERE category_id = $2', [text, cat, active]);
  return {};
});
route('q_delete', { method: 'POST', admin: true }, async ({ body }) => { await q('DELETE FROM questions WHERE id = $1', [intId(body.id)]); return {}; });
route('q_move', { method: 'POST', admin: true }, async ({ body }) => {
  const id = intId(body.id);
  const cur = (await q('SELECT category_id FROM questions WHERE id = $1', [id])).rows[0];
  if (!cur) return {};
  return move('questions', id, Number(body.dir), 'WHERE category_id = $1', [cur.category_id]);
});
route('seed_questions', { method: 'POST', admin: true }, async () => {
  const data = [
    ['Mağaza Dış Görünüm', ['Tabela temiz, sağlam ve ışıkları çalışıyor mu?', 'Mağaza girişi temiz ve engelsiz mi?', 'Vitrin camları temiz mi?']],
    ['Vitrin ve Teşhir', ['Vitrin güncel sezon/kampanya ürünleriyle düzenlenmiş mi?', 'Teşhir ürünlerinde fiyat etiketi var mı?', 'Şişler ve askılar ürün planına uygun dolu mu?']],
    ['Ürün ve Stok', ['Reyonlarda beden/renk eksiği yok mu?', 'Yeni gelen ürünler satış alanına çıkarılmış mı?', 'Depo düzenli ve ürünler etiketli mi?']],
    ['Personel ve Hizmet', ['Personel kıyafet ve yaka kartı kurallarına uygun mu?', 'Müşteri karşılama ve ilgi standartlara uygun mu?', 'Personel güncel kampanyaları biliyor mu?']],
    ['Kasa ve Operasyon', ['Kasa alanı düzenli mi?', 'Kampanya ve indirimler kasada doğru uygulanıyor mu?', 'İade / değişim prosedürü biliniyor mu?']],
    ['Temizlik ve Güvenlik', ['Satış alanı ve soyunma kabinleri temiz mi?', 'Yangın tüpü erişilebilir ve kontrol tarihi geçerli mi?', 'Acil çıkışlar açık ve işaretli mi?']]
  ];
  return tx(async c => {
    if ((await c.query('SELECT 1 FROM categories LIMIT 1')).rowCount) throw bad('Zaten kategori var; örnek sorular yalnızca boş listeye yüklenir.');
    for (let i = 0; i < data.length; i++) {
      const cid = (await c.query('INSERT INTO categories (name, sort) VALUES ($1, $2) RETURNING id', [data[i][0], i + 1])).rows[0].id;
      for (let j = 0; j < data[i][1].length; j++) await c.query('INSERT INTO questions (text, category_id, sort) VALUES ($1, $2, $3)', [data[i][1][j], cid, j + 1]);
    }
    return {};
  });
});

// ---- Ayarlar ----
route('settings_save', { method: 'POST', admin: true }, async ({ body }) => {
  const d = Number(body.maxDistanceM), acc = Number(body.maxAccuracyM);
  if (!Number.isFinite(d) || d < 10 || d > 100000) throw bad('Mesafe 10 ile 100.000 metre arasında olmalı.');
  if (!Number.isFinite(acc) || acc < 5 || acc > 5000) throw bad('Hassasiyet 5 ile 5.000 metre arasında olmalı.');
  await q(`UPDATE app_settings SET photo_required=$1, action_on_no=$2, block_outside=$3, max_distance=$4, max_accuracy=$5, updated_at=now() WHERE id = 1`,
    [!!body.photoRequiredOnNo, !!body.actionOnNo, !!body.blockOutside, Math.round(d), Math.round(acc)]);
  return {};
});

// ---------------------------------------------------------------------
//  Giriş noktası
// ---------------------------------------------------------------------
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const query = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const r = R[query.a];
    if (!r) throw new HttpError(404, 'Bilinmeyen işlem.');
    if (r.method && req.method !== r.method) throw new HttpError(405, 'Geçersiz istek yöntemi.');
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Geçersiz istek.');
    await init();
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const ctx = { req, res, query, body: body || {} };
    if (r.auth !== false) {
      ctx.user = await currentUser(req);
      if (!ctx.user) throw new HttpError(401, 'Oturumunuz sona erdi. Lütfen tekrar giriş yapın.');
      if (r.admin && !isAdmin(ctx.user)) throw new HttpError(403, 'Bu işlem için yönetici yetkisi gerekir.');
    }
    const out = await r.fn(ctx);
    if (r.raw) return;
    send(res, 200, { ok: true, now: Date.now(), ...out });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { ok: false, now: Date.now(), error: e.status ? e.message : 'Sunucu hatası: ' + (e.message || 'bilinmeyen') });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
