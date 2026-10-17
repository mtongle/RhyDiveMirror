# RhyDiveMirror 架构与部署

一套 Cloudflare Workers + R2 的 RhyDive 镜像：**谱面资源落到 R2 并定时与官方同步**，**其他所有 API 端点原样反向代理到官方源**。

```
                     ┌──────────── 官方源（不被修改） ────────────┐
                     │  sta.lunprin.com   (API)                    │
                     │  dl.lunprin.com    (下载站)                 │
                     └───────────────┬─────────────────────────────┘
                                     │ ① 定时拉取目录/清单/ZIP（仅谱面）
                                     │ ② 其余请求逐字转发
                                     ▼
  客户端 ──►  Cloudflare Worker (rhydive-mirror)
                     │
                     ├── 命中谱面路径 ──► R2 对象（archive / assets / catalog / manifest）
                     └── 其他路径 ──────► fetch(官方源)，原样返回状态码/头/体
```

## 1. 路由决策

| 请求 | 处理 |
| --- | --- |
| `GET/HEAD /api/rhydive/library` | R2 `_catalog/library.json`（镜像目录） |
| `GET/HEAD /api/rhydive/library/<id>/download` | R2 `_catalog/manifests/<id>.json` |
| `GET/HEAD /api/rhydive/library/<id>/archive` | R2 `<id>.zip` |
| `GET/HEAD /api/rhydive/assets/<id>/<path>` | R2 `<id>/<path>`，缺失则从 `<id>.zip` 即时解压 |
| `GET/HEAD /rhydive/beatmap/_catalog/library.json` | 同上（下载站表面） |
| `GET/HEAD /rhydive/beatmap/_catalog/manifests/<id>.json` | 同上 |
| `GET/HEAD /rhydive/beatmap/<id>.zip` | 同上 |
| `GET/HEAD /rhydive/beatmap/<id>/<path>` | 同上 |
| `POST/PUT/PATCH/DELETE ...` | **一律转发**（写操作永不镜像） |
| 其他 `GET/HEAD`（`/api/login`、`/api/rhydive/results`、`/api/rhydive/client/*`、`/api/users/*` …） | **转发** |
| 路径像谱面但校验失败（穿越、非法扩展名…） | 本地 `400`，**不**转发 |

镜像未命中时的回退：

- **API 表面**：转发官方 API（未初始化的镜像表现等同纯代理）；
- **下载站表面**：返回 JSON `404`（客户端据此回源 API），或按 `MIRROR_FALLBACK_PROXY` 转发到官方下载站。

## 2. R2 布局

```
_catalog/library.json              镜像目录（官方目录 ∩ 已完整镜像的曲目）
_catalog/manifests/<id>.json       官方清单原文
_catalog/sync-state.json           同步状态（内部）
<id>.zip                           官方 ZIP 原文（逐字节）
<id>/<asset 相对路径>               从 ZIP 解出的资源（策略决定多少）
```

`<id>.zip` 与下载站的 `<id>.zip` 同名同义；`<id>/…` 与 `/api/rhydive/assets/<id>/…` 一一对应。因此同一份 R2 数据同时服务 API 表面与下载站表面。

## 3. 同步器

`runSync()` 一次 tick：

1. 拉取官方目录 `/api/rhydive/library`；
2. 与 `sync-state.json` 做 diff：`archiveHash` 变化或新增 → 入队；官方已删除 → 入回收队列；
3. 在预算内逐曲物化（默认 `SYNC_MAX_SONGS_PER_TICK=6`、`SYNC_BUDGET_MS=20000`）：
   - 拉清单 → 拉 ZIP → **校验 ZIP sha256 == 清单 sha256 == 目录 archiveHash**；
   - 写 `_catalog/manifests/<id>.json`、`<id>.zip`；
   - 按 `SYNC_ASSET_MODE` 解出资源并**逐个校验 sha256**后写入 `<id>/…`；
   - 只有全部成功才把该曲记入 `songs[id]`；
4. 重写镜像目录：**只包含完整镜像的曲目**，保持官方顺序 —— 所以镜像目录里的每一首歌都一定能下载成功；
5. 清理官方已下架的曲目对象；
6. 保存状态。

失败曲目保留在队列里，下一 tick 重试；重试时若 R2 中已有正确 sha256 的 ZIP 则直接复用，不重复下载。

调度：`wrangler.toml` 的 `[triggers] crons`（默认 20 分钟一次）。也可用 `/__admin/sync` 手动触发（批量初始化见 `tools/sync.mjs`）。

### 同步来源（`SYNC_SOURCE`）

官方有两条等价的发布渠道，同步器只从**配置的那一条**读取，不会在失败时静默切换（避免混淆来源权威性）：

| 值 | 读取位置 | 实测速率（3.74 MB 目录，同网络同时刻） |
| --- | --- | --- |
| `api`（默认） | `sta.lunprin.com/api/rhydive/...` | 7.1–8.5 s（0.44–0.53 MB/s） |
| `cdn` | `dl.lunprin.com/rhydive/beatmap/...` | 0.43–0.84 s（4.5–8.6 MB/s，**快约 15×**） |

两者已被逐字节验证等价：ZIP 与单文件资源 sha256 完全一致、清单语义一致、目录 792 首的 id/顺序/`uploadedAt` 完全一致（API 目录仅多出顶层 `storage` 与 13 首曲目的 `accuracy/grade/score` 附加字段）。

无论从哪条源取，镜像落地的都是：**官方 ZIP 原文** + 从该 ZIP 逐项 sha256 校验后解出的资源。也就是说换源只影响拉取速度，不影响镜像内容的权威性。

> 上传瞬间两个源可能不同步（新歌先出现在 API）。`SYNC_SOURCE=cdn` 时若下载站尚未发布该曲，它会被留在队列里下一 tick 重试——已由 `test/sync.test.ts` 的「CDN miss 不回落」用例覆盖。

### 目录哈希与真实字节不一致（`SYNC_HASH_MODE`）

官方目录的 `archiveHash` 是**首发**哈希，歌曲被重传后目录不会刷新（实测 792 首中 1 首，重传 9 h 后仍未变），而 `/download` 与 `/archive` 已经是新字节。镜像必须决定以谁为准：

| 值 | 行为 |
| --- | --- |
| `manifest`（默认） | 以清单/归档真实字节为准发布，并把该曲在镜像目录里的 `archiveHash` 改写成真实 sha256 —— 镜像的目录/清单/归档三者自洽，歌曲不缺席 |
| `strict` | 只发布 `archiveHash` 与真实字节相等的歌；不一致的曲**已镜像但不对外发布**，等官方目录刷新后自动出现（不重复下载） |

两种模式的共同点：**永远不会出现“目录里有、下载却对不上”**。`/__admin/status` 的 `hashRepairs` 报告当前有多少首歌处于“已修正”状态。

### 失败重试退避

某首歌反复失败（源站 404、校验不过）时不会每个 tick 都重试：`sync-state.json` 记录 `failures[id] = {count, lastError, lastAt, catalogHash}`，退避 1 min 起、按次翻倍、上限 6 h；一旦官方目录里该曲的哈希发生变化（说明官方动过它）就立即清除退避、下一 tick 重试。`/__admin/status` 的 `failures` 列出仍在退避中的曲目、原因、尝试次数与下次重试倒计时。

### 资源物化策略（`SYNC_ASSET_MODE`）

| 模式 | 同步时写入 R2 | 首次请求 | 全库存储 |
| --- | --- | --- | --- |
| `all`（默认） | 全部资源 | 直接命中 R2 | ≈21.3 GB |
| `hot` | 封面/音频/`.osu` | 其余从 ZIP 即时解压并回写（write-through） | ≈10.4 GB + 热数据 |
| `lazy` | 只写 ZIP | 全部从 ZIP 即时解压并回写 | ≈10.4 GB + 实际访问到的资源 |

三种模式下**请求语义完全一致**：`Range`/`HEAD`/`ETag`/`Content-Type` 都由同一段代码处理。差异只有存储占用与首次访问的 CPU。

> Workers 免费版 CPU 上限 10 ms，`hot`/`lazy` 首次解压大音频可能超限；默认 `all` 模式 + 付费版（30 s CPU）是推荐组合。免费版可用 `all` 模式规避请求时解压，但同步本身需要付费版计划的 CPU 预算，或用 `tools/sync.mjs` 驱动。

## 4. Google Drive 存储支持（仿照 OpenList / Alist）

对于拥有大容量 Google Drive（如 2 TB / 5 TB Google One / AI Pro 订阅）的用户，系统支持将 Google Drive 作为大文件冷存储底座：

### 4.1 核心设计与权衡

1. **OAuth 用户模式，而非 Service Account**
   - 免费或个人 Google One / AI Pro 计划的容量绑定在个人账号上。Service Account 没有自己的个人存储配额（无法往个人 Drive 写入占自身配额的文件）。因此必须使用个人账号的 OAuth 2.0 `refresh_token`。
2. **最小权限 `drive.file` Scope**
   - 仅申请 `https://www.googleapis.com/auth/drive.file` 权限，无需做敏感 Google 审核。程序仅能读写自身创建的文件，保护主网盘中私人数据。
3. **混合层架构（`STORAGE_LAYOUT = "hybrid"`，强烈推荐）**
   - **R2 免费层 (10 GB)**：存储 `_catalog/*` 元数据、曲目清单、以及封面/音频/`.osu` 谱面热数据（全部 792 首热资源仅需 **3.74 GB**，完全坐落在 R2 10 GB 免费额度内！）。
   - **Google Drive (5 TB)**：存放官方全量 ZIP 归档包（9.86 GB）以及大型背景视频、复杂 Storyboard 等冷资源（约 6.86 GB）。
   - **优势**：
     - 用户浏览、选曲、听试听、进游戏判定等高频操作 100% 走 R2 直出，零延迟且不消耗 Google Drive API 配额。
     - 仅当用户真正点击下载全包或加载背景视频时才打到 Google Drive，且支持 `Range` 流式传输，极大降低触发 Google "Download quota exceeded" 的概率。
4. **扁平化 URL 编码命名，免维护脆弱索引**
   - 文件直接在指定的 Drive 文件夹（`GDRIVE_FOLDER_ID`，不填则自动在根目录创建 `RhyDiveMirror` 文件夹）中以 `encodeURIComponent(key)` 命名。
   - 每次获取通过 `name = '...'` 查询，配合 R2 本地缓存的 OAuth 访问令牌（`_system/gdrive/token.json`），无状态且无需复杂目录映射。

### 4.2 配置步骤

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建项目，启用 **Google Drive API**。
2. 在 **OAuth consent screen** 配置为外部用户（测试模式下添加自己的 Google 邮箱即可）。
3. 在 **Credentials** 创建 **OAuth Client ID**，类型选择 **Web application** 或 **Desktop app**，重定向 URI 添加：
   `http://127.0.0.1:53682`
4. 本地运行获取凭证脚本：
   ```bash
   node tools/gdrive-auth.mjs --client-id <YOUR_CLIENT_ID> --client-secret <YOUR_CLIENT_SECRET>
   ```
   浏览器将自动弹出授权，完成后终端将打印 `GDRIVE_REFRESH_TOKEN`。
5. 配置到 Cloudflare Worker：
   ```bash
   npx wrangler secret put GDRIVE_CLIENT_ID
   npx wrangler secret put GDRIVE_CLIENT_SECRET
   npx wrangler secret put GDRIVE_REFRESH_TOKEN
   # 可选：指定网盘已有文件夹 ID（留空则自动创建）
   # npx wrangler secret put GDRIVE_FOLDER_ID
   ```
6. 修改 `wrangler.toml`：
   ```toml
   [vars]
   STORAGE_LAYOUT = "hybrid" # 开启混合存储
   ```

## 5. 代理的保真度

`proxyRequest()` 只做反向代理**必须**做的事：

- 方法、路径、查询串、请求体（流式）原样转发；
- 去除逐跳头（`connection`、`transfer-encoding`、`host` …），补 `x-forwarded-*`；
- 请求 `accept-encoding: identity`，避免与运行时的自动解压语义打架；
- 响应状态码 / 状态文本 / 头 / 体原样返回；
- `Set-Cookie` **剥离 `Domain` 属性**（并保留多条 Set-Cookie），使上游发给 `sta.lunprin.com` 的会话 Cookie 能存到镜像域；回环主机上还会去掉 `Secure`；
- CORS：反射 `Origin` + `Access-Control-Allow-Credentials: true`（与官方 `Vary: Origin` 行为一致）。

## 6. 一次部署

```bash
cd worker
npm install

# 1) 建桶
npx wrangler r2 bucket create rhydive-mirror

# 2) 管理口令（/__admin/* 的唯一凭据）
npx wrangler secret put SYNC_TOKEN

# 3) 部署
npx wrangler deploy
```

## 7. 初始化与运维

```bash
# 查看同步状态 / 队列 / R2 占用
curl -H "Authorization: Bearer $SYNC_TOKEN" https://<worker>/__admin/status

# 手动跑一次 tick（可放大预算）
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" \
  "https://<worker>/__admin/sync?songs=25&budgetMs=120000"

# 批量灌库（循环调用上面这个接口直到队列空）
node tools/sync.mjs --worker https://<worker> --token "$SYNC_TOKEN"

# 按客户端的方式验收一个部署（15 项检查）
node tools/verify-mirror.mjs --worker https://<worker> --deep
```

`/__admin/status` 的 `storage` 字段区分三种口径，便于估算 R2 账单：

| 字段 | 含义 |
| --- | --- |
| `archiveBytes` | 已物化的 ZIP 总字节（一定存在） |
| `storedAssetBytes` | **同步时**写入 R2 的资源字节（`lazy` 模式下为 0；请求时 write-through 的不计入） |
| `storedBytes` | 上面两者之和 ≈ R2 实际占用 |
| `logicalBytes` | 客户端下载这些歌会拉取的字节数（ZIP + 全部资源） |

### 本地自测（不依赖官方源）

官方源很慢，且有时不可达。仓库自带一个用真实样本驱动的假官方源：

```bash
node tools/fetch-fixture.mjs          # 下载一首真实歌曲到 analysis/fixtures/
node tools/fake-origin.mjs --port 8899 &
cd worker
npx wrangler dev --test-scheduled \
  --var OFFICIAL_ORIGIN:http://127.0.0.1:8899 \
  --var OFFICIAL_CDN_ORIGIN:http://127.0.0.1:8899
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" \
  "http://127.0.0.1:8787/__admin/sync?songs=5&budgetMs=120000"
node ../tools/verify-mirror.mjs --worker http://127.0.0.1:8787 --deep
```

## 8. 客户端接入

**方式 A：把镜像当 API 源**（推荐，无需改 DNS）

编辑 `%APPDATA%/RhyDive/client.json`：

```json
{ "server": "https://<worker-host>", "libraryDirectory": "…" }
```

或设置环境变量 `RHYDIVE_SERVER_ORIGIN=https://<worker-host>`。客户端所有 `/api/...` 都会打到镜像；谱面资源走 R2，其余端点由镜像转发到官方。

> 注意：客户端内置的下载站优先逻辑仍会先试 `dl.lunprin.com`，404 时才回落到本镜像（`fetchRhydiveMirroredAsset` 只在 404 时回退）。若该域名在本机不可达（例如被墙），客户端会**直接失败**而不回退 —— 这属于客户端行为，镜像无法改变。此时更稳的做法是方式 B。

**方式 B：把镜像当下载站**

让 `dl.lunprin.com` 解析到本 Worker（hosts / DNS），镜像的 `/rhydive/beatmap/*` 会直接命中 R2；ZIP 与单文件与官方逐字节一致，客户端校验全部通过。`/rhydive/client/*` 会被转发到官方下载站。

**方式 C：调试模式强制镜像来源**（客户端开发模式）

```bash
RHYDIVE_TEST_MIRROR_ORIGIN=https://<worker-host> RhyDive.exe --rhydive-smoke
```

## 9. 成本估算

按全库 792 首、`all` 模式 ≈21.3 GB（官方 `storage.usedBytes` 10.6 GB 恰好等于其 ZIP 总量，可交叉验证）：

| 项 | 用量 | R2 免费额度 | 备注 |
| --- | --- | --- | --- |
| 存储 | ≈21.3 GB | 10 GB | 超出部分 $0.015/GB·月 ≈ $0.17/月 |
| Class A 写 | 首轮 ≈1.8 万次 + 更新 | 100 万/月 | 增量同步后几乎可忽略 |
| Class B 读 | 与流量相关 | 1000 万/月 | 单曲下载 ≈30 次读 |
| Worker 请求 | 与流量相关 | 10 万/日 | 付费版无硬上限 |

若想留在免费额度内：`SYNC_ASSET_MODE=lazy`（≈10.4 GB，仍略超 10 GB 免费额度）或 `hot` + 只镜像部分曲目。

## 10. 实现注意事项（在真实 workerd 上踩到的坑）

这几点在 Node 里跑不出来，只有 `wrangler dev` / 线上运行时才暴露，已在代码中固化：

1. **`redirect: 'error'` 在 workerd 不支持**。同步客户端改用 `redirect: 'manual'` 并显式拒绝 3xx（`src/official.ts`）。
2. **`fetch` 不能当方法调用**。`this.fetchImpl(...)` 在 workerd 抛 `Illegal invocation: function called with incorrect 'this' reference`；所有可注入的 fetch 默认值都换成 `src/fetch.ts` 里的箭头包装 `globalFetch`。
3. **两个源的速率差很大**：同一时刻实测 3.74 MB 目录，下载站 0.43–0.84 s（4.5–8.6 MB/s），API 源 7.1–8.5 s（0.44–0.53 MB/s）。因此目录超时 300 s、清单 120 s、ZIP 900 s，而 tick 的**墙钟预算**（`SYNC_BUDGET_MS`）才是控制单次同步规模的手段；默认 `SYNC_SOURCE=api`（权威），想要快 15× 就设为 `cdn`。
4. `SYNC_BUDGET_MS` 只在**开始一首歌之前**检查，所以最坏情况下单 tick 会超出预算一首歌的时长（这是刻意取舍：不允许半首歌）。
5. 免费版 CPU 上限 10 ms 对 ZIP 解压不现实；推荐 Workers Paid（30 s CPU）。

## 11. 已知限制

- 同步只覆盖**官方公开曲库**；投稿审核流（`/api/rhydive/submissions/*`）、客户端更新包、账号相关端点一律转发，不做缓存。
- 镜像目录是「官方目录的子集」，因此新增歌曲会在下一个 tick 之后才出现在镜像里（这是刻意设计：宁可晚一点，也不要出现目录里有、下载却没有的歌）。
- 官方源很慢（本次实测 3.5 MB 目录 ≈3 分钟），所以首次全量灌库是长尾过程；`tools/sync.mjs` 会按预算反复调用直到完成。
- 未实现多区域一致性；R2 为单桶单区域，Cloudflare 边缘缓存负责就近分发。
