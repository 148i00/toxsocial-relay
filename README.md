# ToxSocial Relay

ToxSocial 的可选 Relay 服务端，用于：

- 用户目录搜索（Directory）
- 公开帖子分发（Outbox）
- 公共频道列表（Channels）
- 公共频道在线成员上报（Channel Members）

支持 Cloudflare Pages + D1，也保留了一个 Cloudflare Worker + KV 版本。

## 部署到 Cloudflare Pages + D1（推荐）

1. 安装 Wrangler 并登录：

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. 创建 D1 数据库：

   ```bash
   wrangler d1 create toxsocial-db
   ```

   把返回的 `database_id` 填到 `wrangler.toml` 的 `[[d1_databases]]`。

3. 初始化数据库表：

   ```bash
   wrangler d1 execute toxsocial-db --file=schema.sql
   ```

4. 部署：

   ```bash
   wrangler pages deploy public --project-name toxsocial-relay
   ```

5. 绑定自定义域名（可选）：

   ```bash
   wrangler pages project update toxsocial-relay --production-domain your.domain.com
   ```

## 部署到 Cloudflare Worker + KV（旧版）

如果你更想用 Worker + KV，可以改用 `wrangler.worker.toml`：

```bash
wrangler deploy -c wrangler.worker.toml
```

需要先创建三个 KV namespace：

```bash
wrangler kv:namespace create DIRECTORY
wrangler kv:namespace create OUTBOX
wrangler kv:namespace create CHANNELS
```

把返回的 id 填到 `wrangler.worker.toml`。

## 客户端配置

在 ToxSocial 桌面端“设置 → Relay 服务器”里填入你的 Relay 地址，例如：

```text
https://your-relay.example.com
```

客户端会把目录、公开帖子、公共频道、频道成员上报都切换到该 Relay。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/directory?q=` | 搜索用户目录 |
| POST | `/api/directory` | 注册公开资料 |
| GET | `/api/outbox?since=` | 拉取公开帖子 |
| POST | `/api/outbox` | 发布公开帖子 |
| GET | `/api/channels` | 获取公共频道列表 |
| POST | `/api/channels` | 注册/更新公共频道 |
| POST | `/api/channels/members/report` | 上报频道在线成员 |
| POST | `/api/channels/hosts/add` | 添加 co-host |
| POST | `/api/channels/hosts/remove` | 移除 co-host |
| POST | `/api/channels/delete` | 删除公共频道 |
