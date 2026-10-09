// Kuntur · Preguntas del público (Cloudflare Worker + base de datos D1)
//
// El público escanea un QR, se registra (nombre, organización, correo y
// consentimientos) y escribe su pregunta desde el teléfono. Las preguntas
// entran en una cola que modera Eduardo; las aprobadas las toma la pantalla
// de Kuntur y las responde en voz alta, llamando a la persona por su nombre.
// Responsable de los datos: Centro Argentino de Ingenieros (CAI).
//
// Configuración en Cloudflare:
//   Binding D1 (Settings → Bindings → D1 database): nombre DB
//   Secret MOD_KEY: clave del moderador (la eligen ustedes; nunca va en el código)
//   Variable ALLOWED_ORIGIN (opcional): por defecto https://lalolalo1234.github.io
// Las tablas se crean solas en la primera llamada.

const DEFAULT_ORIGIN = 'https://lalolalo1234.github.io';
const MAX_PREGUNTAS = 3;      // por persona
const MAX_TEXTO = 300;        // caracteres por pregunta

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS personas (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     token TEXT UNIQUE NOT NULL,
     nombre TEXT NOT NULL,
     organizacion TEXT,
     cargo TEXT,
     email TEXT NOT NULL,
     pais TEXT,
     idioma TEXT,
     acepta_privacidad INTEGER NOT NULL,
     acepta_encuestas INTEGER NOT NULL,
     evento TEXT,
     creado TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS preguntas (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     persona_id INTEGER NOT NULL,
     texto TEXT NOT NULL,
     idioma TEXT,
     estado TEXT NOT NULL DEFAULT 'pendiente',
     orden REAL,
     creado TEXT NOT NULL,
     actualizado TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const q of SCHEMA) await db.prepare(q).run();
  schemaReady = true;
}

function cors(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  const ok = origin === allowed || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Mod-Key',
    'Vary': 'Origin'
  };
}
const now = () => new Date().toISOString();
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const isEmail = s => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s);

async function getConfig(db, k, def) {
  const r = await db.prepare('SELECT v FROM config WHERE k = ?').bind(k).first();
  return r ? r.v : def;
}
async function setConfig(db, k, v) {
  await db.prepare('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
}
// Comparación de claves en tiempo constante
function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const h = cors(env, origin);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    const fail = (msg, status = 400) => json({ ok: false, error: msg }, status);

    if (request.method === 'OPTIONS') return new Response(null, { headers: h });
    if (!env.DB) return fail('Falta la base de datos (binding DB)', 500);
    await ensureSchema(env.DB);
    const db = env.DB;
    const isMod = () => !!env.MOD_KEY && sameKey(request.headers.get('X-Mod-Key') || url.searchParams.get('key') || '', env.MOD_KEY);
    const body = async () => { try { return await request.json(); } catch (e) { return {}; } };

    // ---------- Público ----------
    if (path === '/estado' && request.method === 'GET') {
      return json({ ok: true, abierta: (await getConfig(db, 'abierta', '0')) === '1', evento: await getConfig(db, 'evento', '') });
    }

    if (path === '/registro' && request.method === 'POST') {
      const b = await body();
      const nombre = clean(b.nombre, 80), organizacion = clean(b.organizacion, 120), cargo = clean(b.cargo, 80);
      const email = clean(b.email, 160).toLowerCase(), pais = clean(b.pais, 60), idioma = b.idioma === 'en' ? 'en' : 'es';
      if (nombre.length < 2) return fail('nombre');
      if (!isEmail(email)) return fail('email');
      if (b.acepta_privacidad !== true) return fail('privacidad');
      const encuestas = b.acepta_encuestas === true ? 1 : 0;
      const evento = await getConfig(db, 'evento', '');
      // Si el mismo correo ya se registró, se actualizan sus datos y se reutiliza su token
      const prev = await db.prepare('SELECT id, token FROM personas WHERE email = ?').bind(email).first();
      if (prev) {
        await db.prepare('UPDATE personas SET nombre = ?, organizacion = ?, cargo = ?, pais = ?, idioma = ?, acepta_privacidad = 1, acepta_encuestas = ? WHERE id = ?')
          .bind(nombre, organizacion, cargo, pais, idioma, encuestas, prev.id).run();
        return json({ ok: true, token: prev.token, nombre });
      }
      const token = crypto.randomUUID();
      await db.prepare('INSERT INTO personas (token, nombre, organizacion, cargo, email, pais, idioma, acepta_privacidad, acepta_encuestas, evento, creado) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .bind(token, nombre, organizacion, cargo, email, pais, idioma, encuestas, evento, now()).run();
      return json({ ok: true, token, nombre });
    }

    if (path === '/pregunta' && request.method === 'POST') {
      const b = await body();
      const p = await db.prepare('SELECT id, nombre FROM personas WHERE token = ?').bind(clean(b.token, 64)).first();
      if (!p) return fail('registro', 401);
      if ((await getConfig(db, 'abierta', '0')) !== '1') return fail('cerrada', 409);
      const texto = clean(b.texto, MAX_TEXTO);
      if (texto.length < 5) return fail('texto');
      const n = await db.prepare('SELECT COUNT(*) AS n FROM preguntas WHERE persona_id = ?').bind(p.id).first();
      if (n.n >= MAX_PREGUNTAS) return fail('limite', 429);
      await db.prepare('INSERT INTO preguntas (persona_id, texto, idioma, estado, creado) VALUES (?, ?, ?, ?, ?)')
        .bind(p.id, texto, b.idioma === 'en' ? 'en' : 'es', 'pendiente', now()).run();
      return json({ ok: true, restantes: MAX_PREGUNTAS - n.n - 1 });
    }

    if (path === '/mis-preguntas' && request.method === 'POST') {
      const b = await body();
      const p = await db.prepare('SELECT id FROM personas WHERE token = ?').bind(clean(b.token, 64)).first();
      if (!p) return fail('registro', 401);
      const r = await db.prepare('SELECT texto, estado FROM preguntas WHERE persona_id = ? ORDER BY id').bind(p.id).all();
      return json({ ok: true, preguntas: r.results, max: MAX_PREGUNTAS });
    }

    // ---------- Moderador y pantalla de Kuntur (requieren MOD_KEY) ----------
    if (!isMod()) return fail('clave', 401);

    if (path === '/mod/cola' && request.method === 'GET') {
      const r = await db.prepare(`SELECT q.id, q.texto, q.idioma, q.estado, q.creado, p.nombre, p.organizacion, p.cargo
        FROM preguntas q JOIN personas p ON p.id = q.persona_id
        WHERE q.estado IN ('pendiente', 'aprobada') OR q.actualizado > ?
        ORDER BY CASE q.estado WHEN 'aprobada' THEN 0 WHEN 'pendiente' THEN 1 ELSE 2 END, COALESCE(q.orden, q.id), q.id`)
        .bind(new Date(Date.now() - 30 * 60 * 1000).toISOString()).all();
      const stats = await db.prepare(`SELECT (SELECT COUNT(*) FROM personas) AS personas, (SELECT COUNT(*) FROM personas WHERE acepta_encuestas = 1) AS encuestas, (SELECT COUNT(*) FROM preguntas) AS preguntas`).first();
      return json({ ok: true, abierta: (await getConfig(db, 'abierta', '0')) === '1', evento: await getConfig(db, 'evento', ''), stats, preguntas: r.results });
    }

    if (path === '/mod/accion' && request.method === 'POST') {
      const b = await body();
      const id = Number(b.id);
      const map = { aprobar: 'aprobada', descartar: 'descartada', respondida: 'respondida', volver: 'pendiente' };
      if (b.accion === 'primero') {
        const m = await db.prepare(`SELECT MIN(COALESCE(orden, id)) AS m FROM preguntas WHERE estado = 'aprobada'`).first();
        await db.prepare(`UPDATE preguntas SET estado = 'aprobada', orden = ?, actualizado = ? WHERE id = ?`).bind((m && m.m != null ? m.m : id) - 1, now(), id).run();
        return json({ ok: true });
      }
      if (!map[b.accion] || !id) return fail('accion');
      await db.prepare('UPDATE preguntas SET estado = ?, actualizado = ? WHERE id = ?').bind(map[b.accion], now(), id).run();
      return json({ ok: true });
    }

    if (path === '/mod/config' && request.method === 'POST') {
      const b = await body();
      if (typeof b.abierta === 'boolean') await setConfig(db, 'abierta', b.abierta ? '1' : '0');
      if (typeof b.evento === 'string') await setConfig(db, 'evento', clean(b.evento, 80));
      return json({ ok: true });
    }

    // La pantalla de Kuntur pide la siguiente pregunta aprobada y la marca como enviada
    if (path === '/mod/siguiente' && request.method === 'POST') {
      const q = await db.prepare(`SELECT q.id, q.texto, q.idioma, p.nombre, p.organizacion FROM preguntas q JOIN personas p ON p.id = q.persona_id
        WHERE q.estado = 'aprobada' ORDER BY COALESCE(q.orden, q.id), q.id LIMIT 1`).first();
      if (!q) return json({ ok: true, pregunta: null });
      const upd = await db.prepare(`UPDATE preguntas SET estado = 'enviada', actualizado = ? WHERE id = ? AND estado = 'aprobada'`).bind(now(), q.id).run();
      if (!upd.meta || !upd.meta.changes) return json({ ok: true, pregunta: null });
      return json({ ok: true, pregunta: q });
    }

    if (path === '/mod/export.csv' && request.method === 'GET') {
      const soloEncuestas = url.searchParams.get('todos') !== '1';
      const r = await db.prepare(`SELECT p.nombre, p.organizacion, p.cargo, p.email, p.pais, p.idioma, p.acepta_encuestas, p.evento, p.creado,
          (SELECT COUNT(*) FROM preguntas q WHERE q.persona_id = p.id) AS preguntas
        FROM personas p ${soloEncuestas ? 'WHERE p.acepta_encuestas = 1' : ''} ORDER BY p.id`).all();
      const cols = ['nombre', 'organizacion', 'cargo', 'email', 'pais', 'idioma', 'acepta_encuestas', 'evento', 'creado', 'preguntas'];
      // Evita que Excel interprete celdas como fórmulas
      const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const csv = '﻿' + cols.join(';') + '\n' + r.results.map(x => cols.map(c => cell(x[c])).join(';')).join('\n');
      return new Response(csv, { headers: { ...h, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kuntur-participantes${soloEncuestas ? '-encuestas' : ''}.csv"`, 'Cache-Control': 'no-store' } });
    }

    // Borrado a pedido de la persona (derecho de supresión)
    if (path === '/mod/borrar' && request.method === 'POST') {
      const b = await body();
      const email = clean(b.email, 160).toLowerCase();
      const p = await db.prepare('SELECT id FROM personas WHERE email = ?').bind(email).first();
      if (!p) return json({ ok: true, borrados: 0 });
      await db.prepare('DELETE FROM preguntas WHERE persona_id = ?').bind(p.id).run();
      await db.prepare('DELETE FROM personas WHERE id = ?').bind(p.id).run();
      return json({ ok: true, borrados: 1 });
    }

    return fail('no encontrado', 404);
  }
};
