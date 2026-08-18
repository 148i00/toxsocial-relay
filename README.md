# ToxSocial Relay

**中文**：ToxSocial 的可选 Relay 服务端，用于用户目录搜索、公开帖子分发、公共频道列表和频道在线成员上报。

**English**: Optional Relay server for ToxSocial. It provides user directory search, public post distribution, public channel listing, and channel member reporting.

Supports Cloudflare Pages + D1 (recommended) and a legacy Cloudflare Worker + KV version.

---

## Deploy to Cloudflare Pages + D1 (Recommended)

1. Install Wrangler and login:

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. Create a D1 database:

   ```bash
   wrangler d1 create toxsocial-db
   ```

   Put the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.

3. Initialize the schema:

   ```bash
   wrangler d1 execute toxsocial-db --file=schema.sql
   ```

4. Deploy:

   ```bash
   wrangler pages deploy public --project-name toxsocial-relay
   ```

5. Optional: bind a custom domain:

   ```bash
   wrangler pages project update toxsocial-relay --production-domain your.domain.com
   ```

## Deploy to Cloudflare Worker + KV (Legacy)

If you prefer Worker + KV, use `wrangler.worker.toml`:

```bash
wrangler deploy -c wrangler.worker.toml
```

Create three KV namespaces first:

```bash
wrangler kv:namespace create DIRECTORY
wrangler kv:namespace create OUTBOX
wrangler kv:namespace create CHANNELS
```

Put the returned IDs into `wrangler.worker.toml`.

## Client Configuration

In the ToxSocial desktop app, open **Settings → Relay Servers** and enter your Relay URL, e.g.:

```text
https://your-relay.example.com
```

The client will use this Relay (or multiple Relays) for directory search, public posts, public channels, and channel member reporting.

## API Overview

| Method | Path | Description |
|---|---|---|
| GET | `/api/directory?q=` | Search user directory |
| POST | `/api/directory` | Register public profile |
| GET | `/api/outbox?since=` | Fetch public posts |
| POST | `/api/outbox` | Publish public post |
| GET | `/api/channels` | List public channels |
| POST | `/api/channels` | Register/update public channel |
| POST | `/api/channels/members/report` | Report online channel member |
| POST | `/api/channels/hosts/add` | Add co-host |
| POST | `/api/channels/hosts/remove` | Remove co-host |
| POST | `/api/channels/delete` | Delete public channel |
