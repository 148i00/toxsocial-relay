// ToxSocial Relay - Cloudflare Pages Functions + D1

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.toxsocial_db;
  if (!db) return json({ error: 'D1 binding not configured' }, 500);

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
    const body = await request.json();
    if (!body.pubkey) return json({ error: 'pubkey required' }, 400);
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
    const body = await request.json();
    if (!body.pubkey || !body.id) return json({ error: 'pubkey and id required' }, 400);
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
    const body = await request.json();
    if (!body.name || !body.hostToxid || !body.channelId) {
      return json({ error: 'name, hostToxid and channelId required' }, 400);
    }
    const hosts = body.hosts && body.hosts.length ? body.hosts : [body.hostToxid];
    const members = body.members && body.members.length
      ? body.members.map((m) => ({ toxid: m, ts: Date.now() }))
      : [{ toxid: body.hostToxid, ts: Date.now() }];
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
    const body = await request.json();
    const { channelId, requesterToxid, newHostToxid } = body;
    if (!channelId || !requesterToxid || !newHostToxid) return json({ error: 'missing' }, 400);
    const row = await db.prepare('SELECT * FROM channels WHERE channel_id = ?1').bind(channelId).first();
    if (!row) return json({ error: 'channel not found' }, 404);
    const hosts = JSON.parse(row.hosts || '[]');
    if (!hosts.includes(requesterToxid)) return json({ error: 'not authorized' }, 403);
    if (!hosts.includes(newHostToxid)) hosts.push(newHostToxid);
    await db.prepare('UPDATE channels SET hosts = ?1 WHERE channel_id = ?2').bind(JSON.stringify(hosts), channelId).run();
    return json({ ok: true });
  }

  if (path === '/api/channels/hosts/remove' && request.method === 'POST') {
    const body = await request.json();
    const { channelId, requesterToxid, removeHostToxid } = body;
    if (!channelId || !requesterToxid || !removeHostToxid) return json({ error: 'missing' }, 400);
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
    const body = await request.json();
    const { channelId, memberToxid } = body;
    if (!channelId || !memberToxid) return json({ error: 'missing' }, 400);
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
    const body = await request.json();
    const { channelId, hostToxid } = body;
    if (!channelId || !hostToxid) return json({ error: 'missing' }, 400);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
