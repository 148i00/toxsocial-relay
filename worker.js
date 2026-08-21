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
      const id = url.searchParams.get('id');
      const since = Number(url.searchParams.get('since') || 0);
      const all = (await env.OUTBOX.get('all', 'json')) || [];
      let items = all;
      if (id) items = items.filter((x) => x.id === id);
      else {
        items = items.filter((x) => x.ts > since);
        if (pubkey) items = items.filter((x) => x.pubkey === pubkey);
      }
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
      // Timestamp sanity: authors sign their own ts, so anyone can backdate
      // or postdate their own posts. Require agreement within ±15s.
      const ts = Number(body.ts);
      const now = Date.now();
      if (!Number.isFinite(ts)) return json({ error: 'invalid ts' }, 400);
      if (Math.abs(ts - now) > 15_000) return json({ error: 'ts out of sync (±15s)' }, 400);
      // Ed25519 signature verification (anti-spoofing). The author's Tox
      // public key is an X25519 key; clients upload the matching Ed25519
      // public key (its birational image) and sign `id|pubkey|ts|text|true`.
      const pubkey = String(body.pubkey).toLowerCase();
      const sig = String(body.sig || '').toLowerCase();
      const edPk = String(body.edPk || '').toLowerCase();
      if (!/^[0-9a-f]{128}$/.test(sig) || !/^[0-9a-f]{64}$/.test(edPk)) {
        return json({ error: 'missing or invalid sig/edPk' }, 400);
      }
      const dataStr = `${body.id}|${pubkey}|${ts}|${String(body.text || '')}|true`;
      const valid = await verifyPostSignature(pubkey, edPk, sig, dataStr);
      if (!valid) return json({ error: 'bad signature' }, 400);
      const all = (await env.OUTBOX.get('all', 'json')) || [];
      if (!all.some((x) => x.id === body.id && x.pubkey === pubkey)) {
        all.push({
          pubkey,
          id: body.id,
          ts,
          text: String(body.text || ''),
          sig,
          type: body.type || 'post',
        });
        await env.OUTBOX.put('all', JSON.stringify(all));
      }
      return json({ ok: true });
    }

    if (path === '/api/outbox/delete' && request.method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return json({ error: parsed.error }, 400);
      const body = parsed.body;
      if (!validPubkey(body.pubkey) || !body.id) return json({ error: 'invalid pubkey or id' }, 400);
      const pubkey = String(body.pubkey).toLowerCase();
      const sig = String(body.sig || '').toLowerCase();
      const edPk = String(body.edPk || '').toLowerCase();
      if (!/^[0-9a-f]{128}$/.test(sig) || !/^[0-9a-f]{64}$/.test(edPk)) {
        return json({ error: 'missing or invalid sig/edPk' }, 400);
      }
      const dataStr = `${body.id}|${pubkey}|${body.ts}|${String(body.text || '')}|true`;
      const valid = await verifyPostSignature(pubkey, edPk, sig, dataStr);
      if (!valid) return json({ error: 'bad signature' }, 400);
      let all = (await env.OUTBOX.get('all', 'json')) || [];
      const before = all.length;
      all = all.filter((x) => !(x.id === body.id && x.pubkey === pubkey));
      await env.OUTBOX.put('all', JSON.stringify(all));
      return json({ ok: true, deleted: all.length < before });
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

// ---------------------------------------------------------------------------
// Ed25519 verification for public posts
// ---------------------------------------------------------------------------
// ToxSocial signs public posts by interpreting the Tox secret seed as an
// Ed25519 seed. The Edwards public key is the birational image of the Tox
// (X25519) public key: y = (u - 1) / (u + 1) mod p. Clients upload their true
// Ed25519 public key (`edPk`) together with the signature; here we verify
// 1) edPk maps back to the author's pubkey, and 2) the standard Ed25519
// signature holds (WebCrypto).

const ED25519_P = (1n << 255n) - 19n; // 2^255 - 19
const MODP_MASK = (1n << 255n) - 1n;

function modpow(base, exp, mod) {
  base %= mod;
  if (base < 0n) base += mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

function hexBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Ed25519/X25519 encodings are little-endian; parse hex accordingly.
function hexLeToBigInt(hex) {
  let le = '';
  for (let i = hex.length - 2; i >= 0; i -= 2) {
    le += hex.slice(i, i + 2);
  }
  return BigInt('0x' + le);
}

async function verifyPostSignature(pubkeyHex, edPkHex, sigHex, dataStr) {
  try {
    const key = await crypto.subtle.importKey(
      'raw', hexBytes(edPkHex), { name: 'Ed25519' }, false, ['verify'],
    );
    // Edwards y -> X25519 u = (1 + y) / (1 - y) mod p.
    const y = hexLeToBigInt(edPkHex) & MODP_MASK;
    if (y === 1n) return false; // (1 - y) == 0 -> no finite image
    const denom = modpow((1n - y) % ED25519_P, ED25519_P - 2n, ED25519_P);
    const u = (((1n + y) % ED25519_P) * denom) % ED25519_P;
    const wantU = hexLeToBigInt(pubkeyHex) & MODP_MASK;
    if (u !== wantU) return false; // edPk does not belong to this author
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      hexBytes(sigHex),
      new TextEncoder().encode(dataStr),
    );
    return ok;
  } catch {
    return false;
  }
}

function withActiveMembers(channel) {
  const now = Date.now();
  const ttl = 5 * 60 * 1000;
  const members = (channel.members || [])
    .filter((m) => m && m.toxid && now - (m.ts || 0) < ttl)
    .map((m) => m.toxid);
  return { ...channel, members };
}
