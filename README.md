# RhyDiveMirror

把 RhyDive 的**公开谱面读取路径**镜像到 Cloudflare Workers，其余 API 路径透明转发到官方源。谱面 ZIP 和资源保持逐字节一致；账号、成绩、投稿和客户端更新请求不会在镜像侧产生第二份数据。

## 适用场景

- 客户端通过 `RHYDIVE_SERVER_ORIGIN` 或 `client.json` 使用镜像作为 API 源。
- 将 `/rhydive/beatmap/*` 作为官方下载站的兼容表面。
- 需要将约 10 GB ZIP 与冷资源放入 Google Drive，只把封面、音频和谱面留在 R2。

不包含：官方端点改写、认证绕过、账号数据缓存、客户端安装包缓存。

## 路由

| 路径 | 行为 |
| --- | --- |
| `GET/HEAD /api/rhydive/library` | 镜像目录 |
| `GET/HEAD /api/rhydive/library/<id>/download` | 镜像清单 |
| `GET/HEAD /api/rhydive/library/<id>/archive` | 镜像 ZIP |
| `GET/HEAD /api/rhydive/assets/<id>/<path>` | 镜像资源；未物化时从 ZIP 提取 |
| `/rhydive/beatmap/...` | 同一份镜像数据的下载站表面 |
| `POST/PUT/PATCH/DELETE ...` | 转发官方源 |
| 其他 `GET/HEAD` | 转发官方源 |
| `/__health` | 配置与存储健康检查 |
| `/__admin/status`、`/__admin/sync`、`/__admin/catalog` | 需 `SYNC_TOKEN` 的运维接口 |

完整契约：[API 文档](docs/API.md)。架构与运维：[架构文档](docs/ARCHITECTURE.md)。

## 快速开始

需要 Node.js 18+。仓库锁定 Wrangler 4.x（当前验证版本 `4.151.1`）及 Workers 类型 5；Wrangler 3 在 Node 24/当前 workerd 上曾发生原生启动崩溃，不要降回旧工具链。

```bash
cd worker
npm ci
npm run typecheck
npm test
```

当前离线测试不依赖官方源。若有 `analysis/fixtures/manifest.json` 和 `archive.zip`，会额外运行真实样本全链路测试。

部署：

```bash
cd worker
npx wrangler r2 bucket create rhydive-mirror
npx wrangler secret put SYNC_TOKEN
npx wrangler deploy
```

首次灌库：

```bash
node tools/sync.mjs --worker https://<worker> --token "$SYNC_TOKEN"
node tools/verify-mirror.mjs --worker https://<worker> --deep
```

## 配置

代码默认值定义在 `worker/src/config.ts`，仓库部署值覆盖在 [`worker/wrangler.toml`](worker/wrangler.toml)。下表“代码默认”用于说明未设置环境变量时的行为；实际部署以 `wrangler.toml` 与 secrets 为准。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SYNC_SOURCE` | `api` | `api` 走官方 API；`cdn` 走官方下载站。只从配置的源读取。仓库文件当前设为 `cdn`。 |
| `SYNC_HASH_MODE` | `manifest` | 以清单/真实 ZIP 为准发布；`strict` 则隐藏官方目录哈希尚未更新的曲目。 |
| `STORAGE_LAYOUT` | `r2` | `r2`、`gdrive` 或 `hybrid`。 |
| `SYNC_ASSET_MODE` | `all` | `all` 物化全部资源；`hot` 只物化封面/音频/谱面；`lazy` 仅存 ZIP。仓库文件当前设为 `hot`。 |
| `SYNC_ASSET_SOURCE` | `archive` | 从 ZIP 提取，或从官方逐个资源获取。 |
| `ARCHIVE_MODE` | `store` | `store` 本地保存 ZIP；`proxy` 请求时回源。 |
| `MIRROR_FALLBACK_PROXY` | `true` | 下载站表面的未命中是否回源。API 表面始终回源。 |
| `SYNC_MAX_SONGS_PER_TICK` | `6` | 每 tick 最多处理的曲目数。 |
| `SYNC_BUDGET_MS` | `20000` | 开始下一首前的墙钟预算。 |
| `GDRIVE_TEAM_DRIVE_ID` | 空 | 共享盘 ID；配置后列表请求使用 `corpora=drive`。 |

仓库默认选择 `SYNC_SOURCE=cdn` 和 `STORAGE_LAYOUT=r2`，无需 Google 凭据即可部署。要把大文件放到 Drive，请显式改为 `hybrid` 或 `gdrive` 并配置下方凭据。单曲同步失败会按 1 分钟起、上限 6 小时退避，详情在 `/__admin/status`。

默认配置并不代表免费额度保证：`r2 + hot` 的完整曲库可能超过 R2 10 GB 免费层，`/__health` 会返回容量警告。全量部署前请先运行容量工具，或选择 `hybrid`/`gdrive`。

## Google Drive

`gdrive` 与 `hybrid` 都需要以下 Worker secret：

```bash
npx wrangler secret put GDRIVE_CLIENT_ID
npx wrangler secret put GDRIVE_CLIENT_SECRET
npx wrangler secret put GDRIVE_REFRESH_TOKEN
```

可选：`GDRIVE_FOLDER_ID`、`GDRIVE_TEAM_DRIVE_ID`、`GDRIVE_CHUNK_SIZE_MB`。授权流程见[架构文档](docs/ARCHITECTURE.md#google-drive)。

`hybrid` 将 ZIP 与冷资源放到 Drive，热资源留在 R2。Drive 不是 CDN，频繁冷读取可能触发下载配额限制。配置变更后保留旧代次对象，读取路径兼容切换存储层。配置步骤：

```bash
npx wrangler secret put GDRIVE_FOLDER_ID   # 可选；省略则自动查找/创建
npx wrangler secret put GDRIVE_TEAM_DRIVE_ID # 仅共享盘需要
```

然后把 `wrangler.toml` 的 `STORAGE_LAYOUT` 改为 `hybrid`。不要提交个人文件夹 ID、OAuth token 或 `.dev.vars`。

## 验证

```bash
cd worker
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

联网 live 测试显式开启：

```bash
cd worker
RHYDIVE_LIVE=1 RHYDIVE_LIVE_SOURCE=cdn npm test -- test/live.test.ts
```

该测试需要真实的官方网络访问。部署后按客户端规则检查：

```bash
node tools/verify-mirror.mjs --worker https://<worker> --deep
```

本次完整审计的实际结果：

- 本地/离线测试：**90 通过**，真实联网测试需显式开启。
- 真实下载站源：目录 902 首，约 7 s，真实歌曲的清单、ZIP、资源及客户端校验通过。
- 真实 API 源：目录 902 首，约 181 s，链路校验通过；API 源明显慢于下载站。
- Wrangler 4 + workerd：本地启动、从空 R2 同步、`verify-mirror --deep` **17/17** 通过，GET/HEAD 条件缓存返回 304。
- `wrangler deploy --dry-run`：约 98 KiB / gzip 24 KiB。

## 容量与限制

容量会随曲库变化，不能把某一时点快照当作承诺。使用 `node tools/plan-capacity.mjs --source cdn` 重新获取**当前全量清单**的精确字节数。报告区分 ZIP、全部资源、热资源与预算内可容纳曲目。

三个关键限制：

1. 客户端将 `text/html` 视为谱面致命错误，镜像错误必须返回 JSON。
2. 客户端逐项校验 ZIP 内的条目数量、名称、大小和 sha256；镜像不能重新打包。
3. 懒加载大资源需要 CPU，R2 免费层不提供足够 CPU；Drive 冷读取受 API 配额限制。

## 自测

下载官方真实样本后，会启用离线全链路测试：

```bash
node tools/fetch-fixture.mjs
cd worker && npm test -- test/offline-e2e.test.ts
```

用本地假源启动 Worker：

```bash
node tools/fake-origin.mjs --port 8899
cd worker
XDG_CONFIG_HOME="$PWD/.wrangler-config" XDG_CACHE_HOME="$PWD/.wrangler-cache" npx wrangler dev --test-scheduled --var OFFICIAL_ORIGIN:http://127.0.0.1:8899 --var OFFICIAL_CDN_ORIGIN:http://127.0.0.1:8899 --var STORAGE_LAYOUT:r2
```

Windows PowerShell 请分别设置 `$env:XDG_CONFIG_HOME` 与 `$env:XDG_CACHE_HOME`。若本机 Wrangler 的原生运行器无法启动，应记录环境错误；不要把离线单元测试当作 workerd 验证。需要真正隔离 R2 状态时，使用绝对路径 `--persist-to <崭新的空目录>`，否则 Wrangler 可能复用 `.wrangler/state`。

## 仓库布局

| 路径 | 内容 |
| --- | --- |
| `worker/src/` | Worker 源码 |
| `worker/test/` | 单元、集成及真实样本测试 |
| `tools/` | 密钥授权、灌库、验收、容量分析、取证工具 |
| `docs/` | API 契约与架构说明 |
| `analysis/` | 本地取证产物；可能含官方内容，不应分发 |

## 免责

本项目只镜像官方公开曲库读取端点。请遵守官方服务条款和内容权利；不要公开分发 `analysis/` 中的谱面样本或解包客户端。
