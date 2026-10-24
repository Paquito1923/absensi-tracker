// Satu-satunya endpoint backend. Tanpa dependensi dan tanpa package.json: bicara ke Upstash Redis lewat REST (fetch bawaan).
//
// Data per user = satu Redis hash "absen2:<username>":
//   mapel          -> JSON daftar mapel: [{ "id": "mab12cd", "name": "Matematika" }, ...]
//   a:<id>:<1..8>  -> "1" bila sudah absen di sesi itu
//   t:<id>:<1..8>  -> "1" bila tugas sesi itu sudah terkumpul
//
// GET   ?u=<username>                         -> { mapel, data: { <id>: { a: [8 boolean], t: [8 boolean] } } }
// PUT   { u, mapel: [{ id?, name }] }          -> simpan daftar mapel (6-8), mapel yang dibuang ikut hilang datanya
// PATCH { u, mapel: <id>, kind, session, value } -> centang / batalkan absen atau tugas

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const N = 8; // sesi per mapel
const MIN = 6; // jumlah mapel minimum
const MAX = 8; // jumlah mapel maksimum
const NAME_MAX = 30;

const validUser = (u) => typeof u === 'string' && /^[a-z0-9_]{3,20}$/.test(u);
const idOk = (s) => typeof s === 'string' && /^m[a-z0-9]{3,8}$/.test(s);
const newId = () => 'm' + (Math.random().toString(36) + '000000').slice(2, 8);
const keyOf = (u) => `absen2:${u}`;

async function redis(...cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
  return j.result;
}

// HGETALL bisa berupa array datar [k, v, k, v...] atau objek, tergantung format respons.
function toObject(res) {
  if (Array.isArray(res)) {
    const o = {};
    for (let i = 0; i < res.length; i += 2) o[res[i]] = res[i + 1];
    return o;
  }
  return res || {};
}

function parseMapel(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((m) => m && idOk(m.id) && typeof m.name === 'string').map((m) => ({ id: m.id, name: m.name }))
      : [];
  } catch {
    return [];
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!REDIS_URL || !REDIS_TOKEN)
    return res.status(500).json({ error: 'Database belum terhubung. Hubungkan Upstash Redis ke proyek Vercel lalu redeploy.' });

  try {
    if (req.method === 'GET') {
      const u = String(req.query.u || '').trim().toLowerCase();
      if (!validUser(u)) return res.status(400).json({ error: 'Username 3–20 karakter: huruf, angka, atau underscore.' });

      const h = toObject(await redis('HGETALL', keyOf(u)));
      const mapel = parseMapel(h.mapel);
      const data = {};
      for (const m of mapel) {
        data[m.id] = {
          a: Array.from({ length: N }, (_, i) => h[`a:${m.id}:${i + 1}`] === '1'),
          t: Array.from({ length: N }, (_, i) => h[`t:${m.id}:${i + 1}`] === '1'),
        };
      }
      return res.status(200).json({ mapel, data });
    }

    if (req.method === 'PUT') {
      const { u: raw, mapel: list } = req.body || {};
      const u = String(raw || '').trim().toLowerCase();
      if (!validUser(u)) return res.status(400).json({ error: 'Username tidak valid.' });
      if (!Array.isArray(list) || list.length < MIN || list.length > MAX)
        return res.status(400).json({ error: `Isi ${MIN} sampai ${MAX} mapel.` });

      const seen = new Set();
      const clean = [];
      for (const item of list) {
        const name = String(item && item.name != null ? item.name : '').replace(/\s+/g, ' ').trim();
        if (!name) return res.status(400).json({ error: 'Nama mapel tidak boleh kosong.' });
        if (name.length > NAME_MAX) return res.status(400).json({ error: `Nama mapel maksimal ${NAME_MAX} karakter.` });
        const k = name.toLowerCase();
        if (seen.has(k)) return res.status(400).json({ error: 'Nama mapel tidak boleh sama.' });
        seen.add(k);
        clean.push({ id: item.id, name });
      }

      const key = keyOf(u);
      const old = parseMapel(await redis('HGET', key, 'mapel'));
      const oldIds = new Set(old.map((m) => m.id));
      const used = new Set();

      // Mapel lama yang id-nya dikirim ulang tetap memakai id itu (datanya terjaga, termasuk bila hanya diganti nama).
      const next = clean.map(({ id, name }) => {
        let nid = id;
        if (!(idOk(nid) && oldIds.has(nid) && !used.has(nid))) {
          do { nid = newId(); } while (oldIds.has(nid) || used.has(nid));
        }
        used.add(nid);
        return { id: nid, name };
      });

      const removed = old.filter((m) => !used.has(m.id));
      if (removed.length) {
        const fields = removed.flatMap((m) =>
          Array.from({ length: N }, (_, i) => [`a:${m.id}:${i + 1}`, `t:${m.id}:${i + 1}`]).flat());
        await redis('HDEL', key, ...fields);
      }
      await redis('HSET', key, 'mapel', JSON.stringify(next));
      return res.status(200).json({ mapel: next });
    }

    if (req.method === 'PATCH') {
      const { u: raw, mapel: id, kind, session, value } = req.body || {};
      const u = String(raw || '').trim().toLowerCase();
      const n = Number(session);

      if (!validUser(u)) return res.status(400).json({ error: 'Username tidak valid.' });
      if (!idOk(id)) return res.status(400).json({ error: 'Mapel tidak valid.' });
      if (!Number.isInteger(n) || n < 1 || n > N) return res.status(400).json({ error: 'Sesi harus 1–8.' });
      if (kind !== 'attendance' && kind !== 'task') return res.status(400).json({ error: 'Jenis data tidak valid.' });
      if (typeof value !== 'boolean') return res.status(400).json({ error: 'Nilai tidak valid.' });

      const key = keyOf(u);
      const mapel = parseMapel(await redis('HGET', key, 'mapel'));
      if (!mapel.some((m) => m.id === id)) return res.status(400).json({ error: 'Mapel tidak ditemukan.' });

      const field = `${kind === 'task' ? 't' : 'a'}:${id}:${n}`;
      if (value) await redis('HSET', key, field, '1');
      else await redis('HDEL', key, field);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
};
