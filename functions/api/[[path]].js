// ToxSocial Relay - Cloudflare Pages Functions + D1
// Basic abuse protection: body size limit, field validation, per-IP rate limit.

const MAX_BODY_BYTES = 20_000;
const WRITE_LIMIT_PER_MINUTE = 30;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.toxsocial_db;
  if (!db) return json({ error: 'D1 binding not configured' }, 500);

  // Basic per-IP write rate limiting.
  if (request.method === 'POST') {
    const limit = await enforceRateLimit(db, request);
    if (!limit.ok) return json({ error: limit.error }, 429);
  }

  // Directory
  if (path === '/api/directory' && request.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let rows = await db.prepare('SELECT * FROM profiles').all();
    let items = rows.results || [];
    if (q) {
      items = items.filter((r) =>
        (r.name || '').toLowerCase().includes(q) || (r.pubkey || '').includes(q)
      );
    }
    return json({ items });
  }

  if (path === '/api/directory' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (!validPubkey(body.pubkey)) return json({ error: 'invalid pubkey' }, 400);
    if (body.toxid && !validToxid(body.toxid)) return json({ error: 'invalid toxid' }, 400);
    if (typeof body.name === 'string' && body.name.length > 128) return json({ error: 'name too long' }, 400);
    if (typeof body.avatar === 'string' && body.avatar.length > 2000) return json({ error: 'avatar too long' }, 400);
    await db.prepare(
      `INSERT INTO profiles (pubkey, name, toxid, avatar, relay, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(pubkey) DO UPDATE SET
         name = excluded.name,
         toxid = excluded.toxid,
         avatar = excluded.avatar,
         relay = excluded.relay,
         updated_at = excluded.updated_at`
    ).bind(body.pubkey, body.name || '', body.toxid || '', body.avatar || '', body.relay || '', Date.now()).run();
    return json({ ok: true });
  }

  // Outbox
  if (path === '/api/outbox' && request.method === 'GET') {
    const pubkey = url.searchParams.get('pubkey');
    const since = Number(url.searchParams.get('since') || 0);
    let stmt = db.prepare('SELECT * FROM posts WHERE ts > ?1');
    if (pubkey) stmt = db.prepare('SELECT * FROM posts WHERE ts > ?1 AND pubkey = ?2');
    const result = pubkey
      ? await stmt.bind(since, pubkey).all()
      : await stmt.bind(since).all();
    let items = result.results || [];
    items.sort((a, b) => a.ts - b.ts);
    return json({ items });
  }

  if (path === '/api/outbox' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (!validPubkey(body.pubkey) || !body.id) return json({ error: 'invalid pubkey or id' }, 400);
    if (typeof body.id !== 'string' || body.id.length > 128) return json({ error: 'id too long' }, 400);
    if (typeof body.text === 'string' && body.text.length > 50000) return json({ error: 'text too long' }, 400);
    if (body.sig && !/^[0-9a-fA-F]{0,128}$/.test(body.sig)) return json({ error: 'invalid sig' }, 400);
    await db.prepare(
      `INSERT OR IGNORE INTO posts (id, pubkey, ts, text, sig)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(body.id, body.pubkey, body.ts || Date.now(), body.text || '', body.sig || '').run();
    return json({ ok: true });
  }

  // Channels
  if (path.startsWith('/api/channels')) {
    await ensureMembersColumn(db);
  }

  if (path === '/api/channels' && request.method === 'GET') {
    const result = await db.prepare('SELECT * FROM channels').all();
    return json({ items: (result.results || []).map(parseChannel) });
  }

  if (path === '/api/channels' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (!body.name || !validToxid(body.hostToxid) || !validChannelId(body.channelId)) {
      return json({ error: 'name, valid hostToxid and channelId required' }, 400);
    }
    if (body.name.length > 128 || (body.desc || '').length > 500) return json({ error: 'name/desc too long' }, 400);
    const hosts = body.hosts && body.hosts.length ? body.hosts : [body.hostToxid];
    if (!Array.isArray(hosts) || !hosts.every(validToxid)) return json({ error: 'invalid hosts' }, 400);
    const members = body.members && body.members.length
      ? body.members.map((m) => ({ toxid: m, ts: Date.now() }))
      : [{ toxid: body.hostToxid, ts: Date.now() }];
    if (!members.every((m) => validToxid(m.toxid))) return json({ error: 'invalid members' }, 400);
    await db.prepare(
      `INSERT INTO channels (channel_id, name, desc, host_toxid, hosts, members, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(channel_id) DO UPDATE SET
         name = excluded.name,
         desc = excluded.desc,
         host_toxid = excluded.host_toxid,
         hosts = excluded.hosts,
         members = excluded.members,
         updated_at = excluded.updated_at`
    ).bind(body.channelId, body.name, body.desc || '', body.hostToxid, JSON.stringify(hosts), JSON.stringify(members), Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/channels/hosts/add' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const { channelId, requesterToxid, newHostToxid } = parsed.body;
    if (!validChannelId(channelId) || !validToxid(requesterToxid) || !validToxid(newHostToxid)) {
      return json({ error: 'invalid channel/toxid' }, 400);
    }
    const row = await db.prepare('SELECT * FROM channels WHERE channel_id = ?1').bind(channelId).first();
    if (!row) return json({ error: 'channel not found' }, 404);
    const hosts = JSON.parse(row.hosts || '[]');
    if (!hosts.includes(requesterToxid)) return json({ error: 'not authorized' }, 403);
    if (!hosts.includes(newHostToxid)) hosts.push(newHostToxid);
    await db.prepare('UPDATE channels SET hosts = ?1 WHERE channel_id = ?2').bind(JSON.stringify(hosts), channelId).run();
    return json({ ok: true });
  }

  if (path === '/api/channels/hosts/remove' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const { channelId, requesterToxid, removeHostToxid } = parsed.body;
    if (!validChannelId(channelId) || !validToxid(requesterToxid) || !validToxid(removeHostToxid)) {
      return json({ error: 'invalid channel/toxid' }, 400);
    }
    const row = await db.prepare('SELECT * FROM channels WHERE channel_id = ?1').bind(channelId).first();
    if (!row) return json({ error: 'channel not found' }, 404);
    let hosts = JSON.parse(row.hosts || '[]');
    if (!hosts.includes(requesterToxid)) return json({ error: 'not authorized' }, 403);
    hosts = hosts.filter((h) => h !== removeHostToxid);
    if (hosts.length === 0) {
      await db.prepare('DELETE FROM channels WHERE channel_id = ?1').bind(channelId).run();
    } else {
      await db.prepare('UPDATE channels SET hosts = ?1 WHERE channel_id = ?2').bind(JSON.stringify(hosts), channelId).run();
    }
    return json({ ok: true });
  }

  if (path === '/api/channels/members/report' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const { channelId, memberToxid } = parsed.body;
    if (!validChannelId(channelId) || !validToxid(memberToxid)) return json({ error: 'invalid channel/toxid' }, 400);
    const row = await db.prepare('SELECT * FROM channels WHERE channel_id = ?1').bind(channelId).first();
    if (!row) return json({ error: 'channel not found' }, 404);
    let members = JSON.parse(row.members || '[]');
    members = members.filter((m) => m.toxid !== memberToxid);
    members.push({ toxid: memberToxid, ts: Date.now() });
    if (members.length > 500) members = members.slice(-500);
    await db.prepare('UPDATE channels SET members = ?1 WHERE channel_id = ?2')
      .bind(JSON.stringify(members), channelId).run();
    return json({ ok: true });
  }

  if (path === '/api/channels/delete' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return json({ error: parsed.error }, 400);
    const { channelId, hostToxid } = parsed.body;
    if (!validChannelId(channelId) || !validToxid(hostToxid)) return json({ error: 'invalid channel/toxid' }, 400);
    const row = await db.prepare('SELECT * FROM channels WHERE channel_id = ?1').bind(channelId).first();
    if (!row) return json({ error: 'channel not found' }, 404);
    const hosts = JSON.parse(row.hosts || '[]');
    if (!hosts.includes(hostToxid)) return json({ error: 'not authorized' }, 403);
    await db.prepare('DELETE FROM channels WHERE channel_id = ?1').bind(channelId).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

function parseChannel(row) {
  return {
    name: row.name,
    desc: row.desc,
    hostToxid: row.host_toxid,
    channelId: row.channel_id,
    hosts: JSON.parse(row.hosts || '[]'),
    members: parseMembers(row.members),
    updated_at: row.updated_at,
  };
}

function parseMembers(raw) {
  const list = JSON.parse(raw || '[]');
  const now = Date.now();
  const ttl = 5 * 60 * 1000;
  return list
    .filter((m) => m && m.toxid && now - (m.ts || 0) < ttl)
    .map((m) => m.toxid);
}

async function ensureMembersColumn(db) {
  try {
    await db.prepare("ALTER TABLE channels ADD COLUMN members TEXT DEFAULT '[]'").run();
  } catch {
    // Column already exists or migration is not needed.
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'body too large' };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'invalid JSON' };
  }
}

async function enforceRateLimit(db, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  await db.prepare('CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT NOT NULL, ts INTEGER NOT NULL)').run();
  await db.prepare('DELETE FROM rate_limits WHERE ts < ?1').bind(now - windowMs).run();
  const row = await db.prepare('SELECT COUNT(*) AS c FROM rate_limits WHERE ip = ?1 AND ts >= ?2').bind(ip, now - windowMs).first();
  const count = row?.c || 0;
  if (count >= WRITE_LIMIT_PER_MINUTE) return { ok: false, error: 'rate limit exceeded' };
  await db.prepare('INSERT INTO rate_limits (ip, ts) VALUES (?1, ?2)').bind(ip, now).run();
  return { ok: true };
}

function validPubkey(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function validToxid(value) {
  return typeof value === 'string' && (/^[0-9a-fA-F]{64}$/.test(value) || /^[0-9a-fA-F]{76}$/.test(value));
}

function validChannelId(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
