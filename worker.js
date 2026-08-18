// ToxSocial optional directory + relay (Cloudflare Worker)
// Uses a single KV key per collection to avoid daily list-operation limits.
//
// KV bindings:
//   DIRECTORY - key "all" -> JSON array of profiles
//   OUTBOX    - key "all" -> JSON array of posts
//   CHANNELS  - key "all" -> JSON array of channels

const MAX_BODY_BYTES = 20_000;
const WRITE_LIMIT_PER_MINUTE = 30;
const rateMap = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!checkRateLimit(ip)) {
        return json({ error: 'rate limit exceeded' }, 429);
      }
    }

    if (path === '/api/directory' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const all = (await env.DIRECTORY.get('all', 'json')) || [];
      const items = all.filter((val) => {
        if (!q) return true;
        return (val.name || '').toLowerCase().includes(q) || val.pubkey.includes(q);
      });
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
      const profile = {
        name: body.name || '',
        pubkey: body.pubkey,
        toxid: body.toxid || '',
        avatar: body.avatar || '',
        relay: body.relay || '',
        updated_at: Date.now(),
      };
      const all = (await env.DIRECTORY.get('all', 'json')) || [];
      const idx = all.findIndex((x) => x.pubkey === profile.pubkey);
      if (idx >= 0) all[idx] = profile; else all.push(profile);
      await env.DIRECTORY.put('all', JSON.stringify(all));
      return json({ ok: true });
    }

    if (path === '/api/outbox' && request.method === 'GET') {
      const pubkey = url.searchParams.get('pubkey');
      const since = Number(url.searchParams.get('since') || 0);
      const all = (await env.OUTBOX.get('all', 'json')) || [];
      let items = all.filter((x) => x.ts > since);
      if (pubkey) items = items.filter((x) => x.pubkey === pubkey);
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
      const all = (await env.OUTBOX.get('all', 'json')) || [];
      if (!all.some((x) => x.id === body.id && x.pubkey === body.pubkey)) {
        all.push({
          pubkey: body.pubkey,
          id: body.id,
          ts: body.ts || Date.now(),
          text: body.text || '',
          sig: body.sig || '',
          type: body.type || 'post',
        });
        await env.OUTBOX.put('all', JSON.stringify(all));
      }
      return json({ ok: true });
    }

    if (path === '/api/channels' && request.method === 'GET') {
      const all = (await env.CHANNELS.get('all', 'json')) || [];
      return json({ items: all.map(withActiveMembers) });
    }

    if (path === '/api/channels' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const body = parsed.body;
      if (!body.name || !validToxid(body.hostToxid) || !validChannelId(body.channelId)) {
        return json({ error: 'name, valid hostToxid and channelId required' }, 400);
      }
      if (body.name.length > 128 || (body.desc || '').length > 500) return json({ error: 'name/desc too long' }, 400);
      const all = (await env.CHANNELS.get('all', 'json')) || [];
      const hosts = body.hosts && body.hosts.length ? body.hosts : [body.hostToxid];
      if (!Array.isArray(hosts) || !hosts.every(validToxid)) return json({ error: 'invalid hosts' }, 400);
      const channel = {
        name: body.name,
        desc: body.desc || '',
        hostToxid: body.hostToxid,
        hosts,
        members: body.members && body.members.length
          ? body.members.map((m) => ({ toxid: m, ts: Date.now() }))
          : [{ toxid: body.hostToxid, ts: Date.now() }],
        channelId: body.channelId,
        updated_at: Date.now(),
      };
      const idx = all.findIndex((x) => x.channelId === channel.channelId);
      if (idx >= 0) all[idx] = channel; else all.push(channel);
      await env.CHANNELS.put('all', JSON.stringify(all));
      return json({ ok: true });
    }

    if (path === '/api/channels/hosts/add' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const { channelId, requesterToxid, newHostToxid } = parsed.body;
      if (!validChannelId(channelId) || !validToxid(requesterToxid) || !validToxid(newHostToxid)) {
        return json({ error: 'invalid channel/toxid' }, 400);
      }
      const all = (await env.CHANNELS.get('all', 'json')) || [];
      const ch = all.find((x) => x.channelId === channelId);
      if (!ch) return json({ error: 'channel not found' }, 404);
      const hosts = ch.hosts || [ch.hostToxid];
      if (!hosts.includes(requesterToxid)) return json({ error: 'not authorized' }, 403);
      if (!hosts.includes(newHostToxid)) hosts.push(newHostToxid);
      ch.hosts = hosts;
      await env.CHANNELS.put('all', JSON.stringify(all));
      return json({ ok: true });
    }

    if (path === '/api/channels/hosts/remove' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const { channelId, requesterToxid, removeHostToxid } = parsed.body;
      if (!validChannelId(channelId) || !validToxid(requesterToxid) || !validToxid(removeHostToxid)) {
        return json({ error: 'invalid channel/toxid' }, 400);
      }
      const all = (await env.CHANNELS.get('all', 'json')) || [];
      const ch = all.find((x) => x.channelId === channelId);
      if (!ch) return json({ error: 'channel not found' }, 404);
      const hosts = ch.hosts || [ch.hostToxid];
      if (!hosts.includes(requesterToxid)) return json({ error: 'not authorized' }, 403);
      ch.hosts = hosts.filter((h) => h !== removeHostToxid);
      if (ch.hosts.length === 0) {
        const idx = all.findIndex((x) => x.channelId === channelId);
        if (idx >= 0) all.splice(idx, 1);
      }
      await env.CHANNELS.put('all', JSON.stringify(all));
      return json({ ok: true });
    }

    if (path === '/api/channels/members/report' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const { channelId, memberToxid } = parsed.body;
      if (!validChannelId(channelId) || !validToxid(memberToxid)) {
        return json({ error: 'invalid channel/toxid' }, 400);
      }
      const all = (await env.CHANNELS.get('all', 'json')) || [];
      const ch = all.find((x) => x.channelId === channelId);
      if (!ch) return json({ error: 'channel not found' }, 404);
      let members = ch.members || [];
      members = members.filter((m) => m.toxid !== memberToxid);
      members.push({ toxid: memberToxid, ts: Date.now() });
      if (members.length > 500) members = members.slice(-500);
      ch.members = members;
      await env.CHANNELS.put('all', JSON.stringify(all));
      return json({ ok: true });
    }

    if (path === '/api/channels/delete' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const { channelId, hostToxid } = parsed.body;
      if (!validChannelId(channelId) || !validToxid(hostToxid)) {
        return json({ error: 'invalid channel/toxid' }, 400);
      }
      const all = (await env.CHANNELS.get('all', 'json')) || [];
      const ch = all.find((x) => x.channelId === channelId);
      if (!ch) return json({ error: 'channel not found' }, 404);
      const hosts = ch.hosts || [ch.hostToxid];
      if (!hosts.includes(hostToxid)) return json({ error: 'not authorized' }, 403);
      const idx = all.findIndex((x) => x.channelId === channelId);
      if (idx >= 0) all.splice(idx, 1);
      await env.CHANNELS.put('all', JSON.stringify(all));
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const list = (rateMap.get(ip) || []).filter((ts) => now - ts < windowMs);
  if (list.length >= WRITE_LIMIT_PER_MINUTE) {
    rateMap.set(ip, list);
    return false;
  }
  list.push(now);
  rateMap.set(ip, list);
  if (rateMap.size > 10_000) {
    for (const [key, value] of rateMap) {
      if (value.every((ts) => now - ts >= windowMs)) rateMap.delete(key);
    }
  }
  return true;
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

function withActiveMembers(channel) {
  const now = Date.now();
  const ttl = 5 * 60 * 1000;
  const members = (channel.members || [])
    .filter((m) => m && m.toxid && now - (m.ts || 0) < ttl)
    .map((m) => m.toxid);
  return { ...channel, members };
}
