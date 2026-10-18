# RhyDive 服务器 API 契约

本文是 `RhyDiveMirror` 的契约来源：哪些端点可镜像、响应必须保持什么形状、哪些不一致会被客户端直接拒绝。标记说明：

- **【观测】**：来自真实 HTTP 响应或字节级校验。
- **【代码】**：来自客户端静态代码，是客户端行为的权威依据。
- **【本地】**：当前仓库的运行时或测试结果，不代表官方现状。

官方服务会变化。线上快照中的曲目数、大小和哈希只说明取证时点；部署前应以当前响应和 `tools/plan-capacity.mjs` 为准。

## 0. 取证来源

| 来源 | 说明 |
| --- | --- |
| 客户端静态分析 | `RhyDive 0.7.2`（Electron）`resources/app.asar`，SHA-256 `54ed0674040c678188c4bb009825fddde7a9a50dccecf7067385e06c7fe1695b`。解包后主要为 `main.mjs`（主进程，含内嵌的渲染层共享模块）与 `renderer/assets/*.js`。 |
| 客户端本地缓存 | `%APPDATA%/RhyDive/Library/remote-catalog.json`（660 首，即 `/api/rhydive/library` 的一次真实响应快照）。 |
| 线上探测 | 2026-10-16 起对 `https://sta.lunprin.com` 与 `https://dl.lunprin.com` 的实际 HTTP 请求（无凭据）。 |
| 双源比对 | 同日抓取的 API 目录（3,743,709 B）与下载站目录（3,741,354 B）逐字段深比对；单曲清单、ZIP、5 个资源逐个 sha256 比对。 |
| 真实样本 | 单曲完整下载样本 `analysis/fixtures/`（manifest + 2.38 MB archive）。 |

## 1. 拓扑

```
客户端 RhyDive 0.7.2
   │
   ├─ API 源   https://sta.lunprin.com            Express（nginx/1.24.0 反代）
   └─ 下载站   https://dl.lunprin.com/rhydive/...  腾讯云 CDN（dnsv1.com）
                ├─ /rhydive/beatmap/   谱面镜像（客户端内置优先级更高的来源）
                └─ /rhydive/client/    客户端安装包 / 增量块
```

关键点：**客户端内置了“谱面优先走下载站、失败再回源 API”的逻辑**（`shared/rhydiveAssetMirror.js`）。因此镜像站有两种可被客户端使用的形态：

1. 作为 **API 源**（客户端 `client.json` 的 `server` / 环境变量 `RHYDIVE_SERVER_ORIGIN` 指向镜像站）；
2. 作为 **下载站**（把 `dl.lunprin.com` 解析到镜像站，或调试模式下用 `RHYDIVE_TEST_MIRROR_ORIGIN`）。

本镜像实现同时提供这两套表面，见 `docs/ARCHITECTURE.md`。

**两源实测对比**（同一时刻、同一网络、3.74 MB 目录，各 3 次）：

| 源 | 耗时 | 速率 |
| --- | --- | --- |
| `dl.lunprin.com/rhydive/beatmap/_catalog/library.json` | 0.43 / 0.49 / 0.84 s | 4.5–8.6 MB/s |
| `sta.lunprin.com/api/rhydive/library` | 7.9 / 8.5 / 7.1 s | 0.44–0.53 MB/s |

上述数字是同一时点的网络观测，不应作为性能承诺。两源内容一致性见 §8；镜像只从配置的源读取，不做失败时静默切换。

## 2. 认证模型

- 基于 Cookie 的会话（Express session），无 Bearer token。
- 客户端渲染层统一用 `fetch(path, { credentials: 'include' })`（Web 版）或主进程 `net.fetch` + `credentials: 'include'`（桌面版）访问 `/api/...`。
- 未登录时受保护端点返回 **HTTP 401** + `{"success":false,"message":"请先登录 Terminus2 账号"}`【观测】。

公开（匿名可访问）端点【观测】：`/api/session/current`、`/api/login`、`/api/register`、`/api/logout`、`/api/rhydive/library`、`/api/rhydive/library/<id>/download`、`/api/rhydive/library/<id>/archive`、`/api/rhydive/assets/<id>/<path>`、`/api/rhydive/client`、`/api/rhydive/client/files/*`、`/api/rhydive/client/blocks/*`、`/api/rhydive/leaderboard`、`/api/rhydive/collections`、`/api/users/<id>`、`/api/users/<id>/avatar/*`。

需要登录【观测 401】：`profile`、`partners`、`story`、`review`、`submissions`、`replays`。

## 3. 端点全集

客户端主进程用一张白名单 `RHYDIVE_CLIENT_ROUTES` 限制可访问路径（防止 `rhydive://` 页面被利用）。该表就是 API 面的权威清单【代码】：

| 方法 | 路径 | 分类 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/session/current` | 转发 | 会话探测，返回 `{success, user}` |
| POST | `/api/login` \| `/api/register` | 转发 | body `{username, password}` |
| POST | `/api/logout` | 转发 | 清 Cookie |
| GET | `/api/rhydive/library` | **镜像** | 曲库目录（约 3.5 MB） |
| GET | `/api/rhydive/library/<id>/download` | **镜像** | 单曲下载清单 |
| GET | `/api/rhydive/library/<id>/archive` | **镜像** | 单曲 ZIP |
| GET | `/api/rhydive/assets/<id>/<path>` | **镜像** | 单文件（封面/音频/谱面/故事板/音效/视频） |
| POST | `/api/rhydive/library` | 转发 | ZIP 上传，需 `x-rhydive-upload-token` 请求头（渲染层实现）【代码】 |
| GET | `/api/rhydive/client` | 转发 | 客户端更新清单（下载包、增量块、changelog） |
| GET | `/api/rhydive/client/files/RhyDive-(Setup\|Portable)-<v>-x64.exe` | 转发 | 安装包 |
| GET | `/api/rhydive/client/files/RhyDive-Manual-<v>-x64.zip` | 转发 | 手动包 |
| GET | `/api/rhydive/client/files/RhyDive-<v>-android.apk` | 转发 | Android 包 |
| GET | `/api/rhydive/client/files/RhyDive-Files-<v>-x64.json` | 转发 | 增量文件清单 |
| GET | `/api/rhydive/client/blocks/<sha256>` | 转发 | 增量内容块 |
| GET | `/api/rhydive/profile` | 转发 | 玩家存档 / 进度 |
| GET | `/api/rhydive/leaderboard` | 转发 | 排行榜 |
| GET | `/api/rhydive/leaderboard/song` | 转发 | 单曲榜（带查询参数） |
| POST | `/api/rhydive/results` | 转发 | 提交成绩（body ≤ 8 MiB + 256 KiB） |
| POST | `/api/rhydive/plays/start` | 转发 | 开局上报 |
| GET | `/api/rhydive/replays?...` | 转发 | 取回放 |
| GET | `/api/rhydive/review`、`/api/rhydive/review/plays/<uuid>/replay` | 转发 | 审核队列 / 回放 |
| POST | `/api/rhydive/review/plays/<uuid>` | 转发 | 审核动作 |
| PUT | `/api/rhydive/review/accounts/<id>` | 转发 | 审核员设置 |
| GET | `/api/rhydive/submissions`、`/api/rhydive/submissions/<uuid>/archive`、`/api/rhydive/submissions/<uuid>/assets/<path>` | 转发 | 投稿列表与投稿内容下载 |
| POST | `/api/rhydive/submissions`（`content-type: application/zip`） | 转发 | 投稿上传 |
| POST | `/api/rhydive/submissions/<uuid>/review` | 转发 | 投稿审核 |
| GET/PUT/DELETE | `/api/rhydive/submissions/reviewers[/<id>]` | 转发 | 审核员名单 |
| GET | `/api/rhydive/collections` | 转发 | 官方分组 / 收藏夹 |
| POST/PATCH/DELETE/PUT | `/api/rhydive/collections/...` | 转发 | 分组与收藏夹增删改（id 为 12 位 hex） |
| GET | `/api/rhydive/partners`、`/api/rhydive/partners/preview/<name>.png` | 转发 | 搭档名单与预览图 |
| POST | `/api/rhydive/progress/play`、PUT `/api/rhydive/progress/partner` | 转发 | 图鉴 / 好感进度 |
| GET/PUT/POST/DELETE | `/api/rhydive/story[/...]` | 转发 | 剧情存档 |
| GET | `/api/rhydive/lyrics/<name>` | 转发 | 歌词 PV |
| PUT | `/api/rhydive/settings` | 转发 | 服务端设置 |
| GET | `/api/users/<id>`、`/api/users/<id>/avatar/{layered,avatar,cutoutAvatar}` | 转发 | 用户资料与头像（单请求 ≤ 50 MiB） |
| PUT | `/api/users/<id>` | 转发 | 改资料（≤ 50 MiB） |
| POST | `/api/cutout` | 转发 | 抠图（≤ 50 MiB） |
| GET | `/emote-widget/models/<name>.psb` | 转发 | 表情组件模型 |

镜像站只接管上表标 **镜像** 的 4 类路径；其余一律**不解析、不改写**地转发官方源。

## 4. 数据形状

### 4.1 曲库目录 `GET /api/rhydive/library`【观测】

```jsonc
{
  "success": true,
  "songs": [
    {
      "id": "cysmix-triangles-1841885-a702605d",
      "source": "server-upload",
      "archiveHash": "a702605d…9e4b",        // = 官方 ZIP 的 sha256
      "title": "triangles",
      "nativeTitle": "triangles",
      "artist": "cYsmix",
      "mapper": "yf_bmp",
      "cover": "/api/rhydive/assets/<id>/bg.png",
      "audio": "/api/rhydive/assets/<id>/audio.mp3",
      "previewTime": 87.012,
      "bpm": 160,
      "length": "2:03",
      "accent": "#93a9d6",
      "uploadedAt": "2026-10-16T01:07:33.546Z",
      "tutorial": false,
      "hitSounds": [{ "name": "drum-hitclap.ogg", "url": "/api/rhydive/assets/<id>/drum-hitclap.ogg" }],
      "difficulties": [
        {
          "name": "Easy",
          "stars": 2.18,
          "sourceStars": 1.7,
          "sourceMode": 0,
          "level": "IMPORTED",
          "beatmap": "/api/rhydive/assets/<id>/cYsmix%20-%20triangles%20(yf_bmp)%20%5BEasy%5D.osu",
          "backgroundVideo": null,
          "storyboards": ["/api/rhydive/assets/<id>/cYsmix%20-%20triangles%20(yf_bmp).osb"],
          "ratingMeta": { "rating": 2.18, "weightedNotes": 149.5, "durationSeconds": 119.91, "weightedDensity": 1.247, "formula": "laser*0.75 + other*1 per second" }
        }
      ]
    }
  ]
}
```

- 所有资源地址都是**相对该响应的同源路径**（`/api/...`），因此目录本身不含域名。镜像站直接复用即可。
- 取证快照为 **792 首**，`uploadedAt` 覆盖 `2026-08-10T16:03:54.828Z` → `2026-10-16T22:00:59.036Z`，全部 `source = "server-upload"`。曲库会变化，不能把该数量硬编码进部署逻辑。
- 曲目 id 满足 `^[A-Za-z0-9._~-]{1,96}$`（792/792 通过，无重复）。
- **`archiveHash` 可能过期**【观测 2026-10-17】：被重传过的歌，目录里的 `archiveHash` 仍是**首发时**的哈希（id 后缀就是它），而 `/download` 清单与 `/archive` 早就换成新字节。实测 792 首中 1 首（`mafumafu-good-bye-sengen-1489661-ebb1dcd6`：目录 `ebb1dcd6…`，清单/归档 `4fddd188…`），且重传 9 小时后目录仍未刷新。**API 与下载站的目录都这样**，不是单一源的问题。
  - 客户端**下载流程不看这个字段**（`readManifest`/`publishArchive` 只校验清单与 ZIP），所以镜像按清单哈希发布不会破坏下载；
  - 但 `archiveHash` 被用于本地导入去重（导入 `.osz` 时按 `archiveHash` 找同曲）与 osu-connect 的 `decoded.hash` 比对，此时真实哈希比过期的目录哈希更准确。
- API 源比下载站源多两处**附加字段**（其余逐字段完全相同，见 §8）：
  - 顶层 `storage`：`{"usedBytes":10599949932,"quotaBytes":21474836480}` —— 官方服务器自身占用 10.6 GB / 20 GiB 配额；
  - 13 首曲目的 51 个 difficulty 上多出 `accuracy` / `grade` / `score`（形如 `"accuracy":"—","grade":"—"`）。

### 4.2 单曲清单 `GET /api/rhydive/library/<id>/download`【观测】

```jsonc
{
  "success": true,
  "song": { /* 与目录中的 song 对象同构 */ },
  "files": [
    { "name": "SB/D1.png", "url": "/api/rhydive/assets/<id>/SB/D1.png", "size": 19573, "sha256": "7dc7b444…" }
  ],
  "archive": { "url": "/api/rhydive/library/<id>/archive", "size": 7707399, "sha256": "a702605d…" },
  "totalBytes": 9843765
}
```

- `files[].sha256` 是**解压后**内容的 sha256；`archive.sha256` 是 ZIP 本体的 sha256，且等于目录里的 `archiveHash`【观测 + 代码校验】。
- 文件名为 **ZIP 内相对路径**（可能有 `SB/…` 子目录），URL 中的每一段按 `encodeURIComponent` 编码。

### 4.3 单曲 ZIP `GET /api/rhydive/library/<id>/archive`

响应头【观测】：

```
Content-Type: application/zip
Content-Length: 7707399
Content-Disposition: attachment; filename="cysmix-triangles-1841885-a702605d.zip"
ETag: W/"759b07-…"
```

官方 ZIP 响应在该快照中未提供 `Accept-Ranges`。镜像个体会支持 Range，以便流式或断点读取；ZIP 内容本身仍保持逐字节官方原文。

### 4.4 单文件 `GET /api/rhydive/assets/<id>/<path>`

响应头【观测】：

```
Content-Type: image/png        （或 audio/mpeg、text/plain… 始终是具体类型）
Content-Length: 330015
Accept-Ranges: bytes
Cache-Control: public, max-age=31536000, immutable
Last-Modified: Fri, 16 Oct 2026 01:07:33 GMT
ETag: W/"5091f-1a14240036f"
```

`Range: bytes=0-99` 返回 `206 Partial Content` + `Content-Range: bytes 0-99/3549639`【观测】。

### 4.5 其他已观测响应

```jsonc
// GET /api/session/current  (200)
{ "success": false, "user": null }

// GET /api/rhydive/client  (200, 6.8 KB)
{ "success": true, "client": {
    "version": "0.7.2", "platform": "win32-x64",
    "downloads": [{ "kind": "setup", "name": "RhyDive-Setup-0.7.2-x64.exe", "bytes": 405846093,
                    "builtAt": "2026-10-14T13:54:12.000Z", "sha256": "35ffbf97…" }],
    "files":   { "name": "RhyDive-Files-0.7.2-x64.json", "bytes": 161721, "sha256": "7aad3cba…" },
    "changelog": [{ "version": "0.7.2", "date": "2026-10-14", "title": "…", "changes": ["…"] }] } }

// GET /api/rhydive/leaderboard  (200)
{ "success": true, "leaderboard": [{ "userId": "1791899987432", "username": "lh_along",
    "avatar": "/api/users/1791899987432/avatar/layered?v=2477a8b9…", "rating": 1203.05,
    "clears": 53, "diveClears": 53, "wavcClears": 0, "bestSyncRate": 323.11, "bestScore": 4017732,
    "lastPlayedAt": "2026-10-16T13:…" }] }

// GET /api/rhydive/collections  (200)
{ "success": true, "official": { "tiers": { "<songId>": "regular", … } } }

// 受保护端点（401）
{ "success": false, "message": "请先登录 Terminus2 账号" }
```

## 5. 客户端镜像契约【代码】

这一段是本镜像站必须精确复刻的部分，取自 `shared/rhydiveAssetMirror.js`：

| 逻辑 URL | 镜像 URL |
| --- | --- |
| `/api/rhydive/assets/<id>/<path>` | `<ASSET_BASE><id>/<每段 encodeURIComponent 后的 path>` |
| `/api/rhydive/library` | `<ASSET_BASE>_catalog/library.json` |
| `/api/rhydive/library/<id>/download` | `<ASSET_BASE>_catalog/manifests/<id>.json` |
| `/api/rhydive/library/<id>/archive` | `<ASSET_BASE><id>.zip` |
| `/api/rhydive/client/files/RhyDive-<x>.{exe,zip,apk,json}` | `<CLIENT_BASE><x>` |
| `/api/rhydive/client/blocks/<sha256>` | `<CLIENT_BASE>blocks/<sha256>.gz` |

官方常量：`ASSET_BASE = https://dl.lunprin.com/rhydive/beatmap/`、`CLIENT_BASE = https://dl.lunprin.com/rhydive/client/`。

**镜像取值的请求语义**（`fetchRhydiveMirroredAsset`）：

- 只有 `GET` / `HEAD` 会走镜像；
- 只转发 `accept` 与 `range` 两个请求头；
- `credentials: 'omit'`、`redirect: 'error'`、`mode: 'cors'`、`referrerPolicy: 'no-referrer'`、`cache: 'no-cache'`；
- **404 → 回源到 API**（这是唯一的回退路径）；
- 网络异常/其他非 2xx → **直接失败**，不回源；
- 2xx 但 `Content-Type` 匹配 `text/html` → **直接失败**（错误信息：「谱面外链返回了网页，请检查文件是否允许公开直连」）。

因此镜像必须：任何谱面路径都不能返回 HTML；支持 CORS；支持 Range；下载站表面缺失时返回干净的 JSON 404。API 表面的未命中按客户端规则回源。

**资产路径校验**（对镜像 URL 的构造）：

- 只接受扩展名 ∈ `{.osu,.osb,.mp3,.ogg,.wav,.flac,.m4a,.mp4,.webm,.ogv,.jpg,.jpeg,.png,.webp,.gif}`；
- 路径段不得为空、不得以 `.` 开头、不得含 `/ \ :` 或控制字符；
- id 匹配 `[\w-]{1,96}`。

## 6. 客户端下载校验【代码】

桌面端 `readManifest` / `publishArchive`：

1. 清单：`success === true`、`song.id === <请求的 id>`、`files` 为长度 1..5000 的数组；
2. 每一项 `file.url` 必须**恰好等于** `/api/rhydive/assets/<id>/<encodeURIComponent 后的 name，逐段>`；
3. `file.size` 为 `0..128 MiB` 的安全整数，`file.sha256` 为 64 位 hex，`name` 不区分大小写唯一；
4. `Σ file.size ≤ RHYDIVE_MAX_EXPANDED_MB`（默认 512 MiB）；
5. `archive.url` 必须恰好是 `/api/rhydive/library/<id>/archive`，`archive.size ∈ (0, RHYDIVE_MAX_UPLOAD_MB]`（默认 256 MiB），`archive.sha256` 为 64 位 hex；
6. 下载后：`sha256(ZIP) === archive.sha256`，且 ZIP 解压出的条目集合必须与 `files` **一一对应**（数量、名称、大小、sha256 全部一致），否则整包作废。

浏览器端另有 CacheStorage 缓存：`rhydive-beatmaps-v2`（谱面）、`rhydive-covers-v1`（曲绘），并以 `cache: 'force-cache'` 读取。

> 结论：镜像**不能**重新打包 ZIP、不能改写清单、不能改文件名编码 —— 必须逐字节转发官方对象与其清单。

## 7. 存储规模观测

对 12 首（按目录均匀抽样）的真实清单统计，并按当时 792 首推算：

| 指标 | 均值 | 全库推算（792 首） |
| --- | --- | --- |
| 文件数/曲 | 27（3 … 164） | ~21,400 个对象 |
| 解压后资源 | 13.8 MB | ~10.9 GB |
| 官方 ZIP | 13.1 MB | ~10.4 GB |
| 两者都存 | 26.9 MB | ~21.3 GB |

**与官方自报数据交叉验证**：API 目录的 `storage.usedBytes = 10,599,949,932`（≈10.6 GB，配额 20 GiB），与「792 × 13.1 MB ≈ 10.4 GB」的 ZIP 总量吻合到 ~2%。这说明
（a）抽样均值可靠，
（b）**官方服务器自己只存了一份（≈ZIP 大小）**，而镜像若同时物化 ZIP 与全部资源大约需要 2×。

因此默认策略是「ZIP 必存 + 资源可选物化」。精确预算应在目标时点运行 `node tools/plan-capacity.mjs --source cdn`，而不是把本表当作当前账单。

## 8. 双源等价性与边界

**已解决 —— 两套表面是否同构【观测】**：抓取两边的目录、清单、ZIP 与资源后逐项比对：

| 对象 | 结论 |
| --- | --- |
| `<id>.zip` | **逐字节相同**（sha256 = 目录里的 `archiveHash`） |
| `_catalog/manifests/<id>.json` vs `/api/.../download` | 语义完全相同（顶层键 `success,song,files,archive,totalBytes`；`files[]`/`archive` 完全一致） |
| 5 个单文件资源 | **逐字节相同**（sha256 与清单一致），`Content-Type` 具体（`.osu` → `text/plain; charset=utf-8`，封面 → `image/jpeg`），`Cache-Control: public, immutable, max-age=31536000` |
| `_catalog/library.json` vs `/api/rhydive/library` | 792 首、id 集合相同、**顺序相同**、`uploadedAt` 完全相同；逐字段深比对 779/792 首完全一致 |
| 差异 | API 目录多出顶层 `storage` 键；13 首曲目的 difficulty 上多出 `accuracy`/`grade`/`score`；其余无差别 |

在所抓快照和样本范围内，下载站是 API 的等价发布渠道（除两处附加字段），可配置为同步来源。该结论不扩展为“任意时刻两个源完全同步”：上传窗口、网络故障或服务更新仍可能需要重试。

**补充观测 —— 目录与清单可能自相矛盾（上表之外的“不一致”来源）**：`archiveHash` 描述的是首发字节，重传后目录不更新（详见 §4.1）。因此「两源目录一致」并不等于「目录与清单一致」。镜像的取舍是：以**清单/归档实际字节**为准发布，并把该字段改写成真实的 sha256（见架构文档 `SYNC_HASH_MODE`），这样镜像自己的目录、清单、归档三者始终自洽。

**仍有边界**：

- 官方 ZIP 是否可能出现 ZIP64 / 非 UTF-8 文件名：已抽样 792 首中的 12 首 + 1 首完整样本，未出现；读取器已实现 ZIP64 与容错解码。
- 两个源的速率限制与防盗链策略：本次探测未触发任何限制（含 CDN `/` 返回 403，但 `/rhydive/...` 正常）；同步器内置请求预算。
- 新歌在 API 与下载站之间的**可见性时延**：本次抓取两源一致（同一 `uploadedAt`、同一顺序），但上传瞬间两者可能不同步；`SYNC_SOURCE=cdn` 时若下载站尚未发布某首歌，该曲会留在队列里下个 tick 重试（已测试，不会静默改用另一个源）。
- 会话 Cookie 是否带 `Domain=sta.lunprin.com`：无法在未登录情况下观测到 `Set-Cookie`；镜像代理统一剥离 `Domain` 属性以兼容两种情形。
- 客户端或官方服务升级可能改变端点白名单、大小限制和响应形状。修改镜像前应重新核对当前客户端代码与真实响应。

## 9. 当前镜像的实现边界

- 镜像目录只包含已经完整物化并提交的曲目；目录不承诺当前官方曲库中的每一首都已可下载。
- 清单、ZIP 代次与资源代次是不可变对象；固定旧路径仅用于兼容。发布依据是 `_catalog/songs/<id>.json` 指针，详见[架构文档](ARCHITECTURE.md)。
- 锁、状态冲突和 Drive 限流属于服务错误，不应返回 HTML，也不应伪装成 404。
- 联网 live 测试需要真实网络；本仓库的真实样本离线测试只能证明解析、校验和当前 Worker 流程正确，不能替代官方线上验证。
