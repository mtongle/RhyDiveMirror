# RhyDiveMirror

RhyDive（Electron 音游客户端 0.7.2）服务器 API 的逆向成果 + 一套可直接部署的 **Cloudflare Workers + R2 镜像站**。

- **谱面**（曲库目录 / 单曲清单 / ZIP / 封面音频谱面等资源）→ 落到 **R2**，由 Cron 定时与官方 API 同步；
- **其他所有端点**（登录、成绩、排行、投稿、客户端更新包、头像…）→ **原样反向代理**到官方源，不解析、不改写、不缓存。

```
RhyDive 客户端 ──► rhydive-mirror (Worker)
                     ├─ /api/rhydive/{library,assets,...}      ──► R2
                     ├─ /rhydive/beatmap/...                   ──► R2
                     └─ 其余全部                                ──► sta.lunprin.com / dl.lunprin.com
                                                                     （状态码/头/体原样透传）
```

## 目录

| 路径 | 内容 |
| --- | --- |
| [docs/API.md](docs/API.md) | 逆向出的官方 API 契约：端点全集、数据形状、认证、客户端镜像协议与校验规则 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 镜像设计、R2 布局、同步算法、代理保真度、部署与运维 |
| [worker/](worker) | Worker 实现（TypeScript）+ 68 个单元/集成测试 |
| [worker/test/live.test.ts](worker/test/live.test.ts) | 对真实官方 API 的端到端验证（`RHYDIVE_LIVE=1`） |
| [tools/gdrive-auth.mjs](tools/gdrive-auth.mjs) | 交互式获取 Google Drive OAuth Refresh Token 脚本 |
| [tools/plan-capacity.mjs](tools/plan-capacity.mjs) | 官方全量 792 首清单精确容量分析与规划工具 |
| [tools/verify-mirror.mjs](tools/verify-mirror.mjs) | 按客户端规则验收任意一个已部署镜像（15 项检查） |
| [tools/sync.mjs](tools/sync.mjs) | 批量灌库 / 维护驱动（循环调用 `/__admin/sync`） |
| [tools/fake-origin.mjs](tools/fake-origin.mjs) | 用真实样本顶替官方 API 的本地假源（离线自测） |
| [tools/fetch-fixture.mjs](tools/fetch-fixture.mjs) | 抓取一首真实歌曲作为测试样本 |
| [tools/asar-extract.mjs](tools/asar-extract.mjs) | 零依赖 asar 解包器（逆向取证用） |
| [tools/probe-stats.mjs](tools/probe-stats.mjs) | 抽样统计官方曲库规模（用于容量规划） |
| [analysis/](analysis) | 逆向取证产物（解包源码、真实样本、探测数据） |

## 快速开始

```bash
cd worker
npm install
npm run typecheck      # tsc ×2（src 用 Workers 类型；test 额外带 node 类型）
npm test               # 45 tests
npm run dev            # 本地 wrangler dev（Miniflare + 本地 R2）
```

部署：

```bash
npx wrangler r2 bucket create rhydive-mirror
npx wrangler secret put SYNC_TOKEN
# 首次灌库想快 15×：在 wrangler.toml 里把 SYNC_SOURCE 改成 "cdn"
#   api = sta.lunprin.com（权威，默认）   cdn = dl.lunprin.com（官方下载站，快）
npx wrangler deploy
node ../tools/sync.mjs --worker https://<worker> --token "$SYNC_TOKEN"   # 首次灌库
node ../tools/verify-mirror.mjs --worker https://<worker> --deep         # 按客户端规则验收
```

详见 [docs/ARCHITECTURE.md §5](docs/ARCHITECTURE.md)。

## 关键结论（为什么这样做）

1. **客户端自带镜像协议。** `shared/rhydiveAssetMirror.js` 里硬编码了 `https://dl.lunprin.com/rhydive/beatmap/` 与 `.../client/`，并规定：谱面资源优先走下载站，**只有 404 才回源 API**，其余错误直接失败，且**任何 `text/html` 响应都会被视为致命错误**。镜像站因此必须逐字节保真、必须支持 `Range`、必须返回具体 `Content-Type`、缺失时必须干净 404。

2. **ZIP 必须原样保存。** 桌面端下载后会用清单逐项校验解压结果（数量、路径、大小、sha256 全等），任何重新打包都会让整包作废。所以镜像存的是官方 ZIP 原文，资源则是从同一份 ZIP 解出来的派生对象。

3. **镜像目录只列完整镜像的曲目。** 避免出现「目录里有、下载 404」的状态；新歌在下一次同步 tick 之后出现。

   更进一步：官方目录的 `archiveHash` 是**首发**哈希，歌曲被重传后目录不刷新（实测 792 首中 1 首，重传 9 小时后仍未变），而清单/ZIP 已是新字节。默认 `SYNC_HASH_MODE=manifest` 以真实字节为准发布并改写该字段，保证镜像的**目录 / 清单 / 归档三者自洽**；`strict` 模式则选择不发布这类曲目。失败曲目按 1 min→6 h 指数退避重试（`/__admin/status` 可见原因与下次重试时间）。

4. **写操作永不镜像。** 所有非 `GET/HEAD` 请求直接转发，避免账号/成绩/投稿数据在镜像侧产生第二份真相。

## 已验证

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（src 与 test 两套配置） |
| `npm test` | **45/45 通过**（路由、ZIP 读取、Range/ETag、同步幂等、上游变更、下架回收、代理透传、Cookie 重写、管理鉴权） |
| ZIP 读取器 vs 真实样本 | 对官方 2.38 MB ZIP 的 5 个条目逐一 `sha256` 校验通过（`test/zip.test.ts`） |
| 线上端到端（`RHYDIVE_LIVE=1`，API 源） | 真实官方目录（**792 首**）→ 真实歌曲入 R2 → 目录/清单/ZIP/资源全部按客户端规则复验通过（7.3 s） |
| 线上端到端（`RHYDIVE_LIVE_SOURCE=cdn`） | 同一条链路走官方下载站：目录 792 首 **2.1 s**（API 源同条件 7.1–8.5 s），产物 sha256 一致（2.9 s） |
| 真实 workerd 运行时（`wrangler dev` + 假官方源） | 同步 1 首成功（`processed=1, failed=0`）；`tools/verify-mirror.mjs --deep` **15/15 通过**：ZIP 逐字节一致、5/5 条目 sha256 一致、ZIP 与资源 Range 206、CDN 表面、转发、穿越拦截 |
| 真实 workerd 运行时（`lazy` 模式） | 只存 ZIP（2.38 MB），资源按需从 ZIP 解压（workerd 的 `DecompressionStream('deflate-raw')`）并回写，15/15 通过 |
| 真实 workerd + 真实下载站（`SYNC_SOURCE=cdn`） | 3 首连同步（目录+清单+ZIP+解包入库）15 s，0 失败；`verify-mirror --deep` 15/15；并实测把官方目录里过期的 `archiveHash` 修正后正常发布（`repaired=2`，`hashRepairs=2`） |
| Cron / `ctx.waitUntil` | `/__scheduled` 触发成功，日志输出 `{"event":"sync",...}`；第二次 tick `processed=0, catalogChanged=false`（幂等） |
| 写操作透传 | `POST /api/rhydive/results` 原样转发，请求体与响应状态码保持 |

> 真实运行时暴露并已修复的两个问题：workerd 不支持 `redirect: 'error'`；把全局 `fetch` 当方法调用（`this.fetchImpl(...)`）会抛 `Illegal invocation`。两者在 Node 下均不会复现 —— 详见 [docs/ARCHITECTURE.md §9](docs/ARCHITECTURE.md)。

## 自测（不依赖官方源，秒级）

```bash
node tools/fetch-fixture.mjs                 # 抓一首真实歌作为样本
node tools/fake-origin.mjs --port 8899 &     # 用样本顶替官方 API
cd worker && npx wrangler dev --test-scheduled \
  --var OFFICIAL_ORIGIN:http://127.0.0.1:8899 \
  --var OFFICIAL_CDN_ORIGIN:http://127.0.0.1:8899
curl -X POST -H "Authorization: Bearer $SYNC_TOKEN" \
  "http://127.0.0.1:8787/__admin/sync?songs=5&budgetMs=120000"
node ../tools/verify-mirror.mjs --worker http://127.0.0.1:8787 --deep
```

## 容量与 Google Drive 混合存储（实测 792 首全库精确账目）

通过 `tools/plan-capacity.mjs` 对全量 792 个清单进行逐字节求和实测：
- 官方全部 ZIP 总量：**9.86 GB**（与官方 API 自报 `storage.usedBytes = 10.6 GB` 一致）
- 全部解压文件总量：**10.60 GB**
- 热文件（封面、音频试听、`.osu` 谱面）总量：**3.74 GB**

### 存储模式与方案对照

| 方案 | R2 占用 | Google Drive 占用 | 适用场景 |
| --- | --- | --- | --- |
| **纯 R2 (`STORAGE_LAYOUT=r2, all`)** | ≈20.45 GB | 0 | 付费 R2 计划 |
| **纯 R2 极简 (`STORAGE_LAYOUT=r2, lazy`)** | **9.86 GB** | 0 | 刚好卡在 R2 10 GB 免费额度边缘 |
| **Google Drive 混合架构 (`STORAGE_LAYOUT=hybrid`)** *(推荐)* | **3.74 GB** | **16.72 GB** | **完美结合 R2 10 GB 免费层与 5 TB Google Drive** |

> **强烈推荐 `hybrid` 混合模式**：
> 高频访问的封面/试听/谱面文件（仅 3.74 GB）存放在 Cloudflare R2 免费层，零延迟、无流控且免 API 费用；
> 体积巨大的 ZIP 打包文件（9.86 GB）及大体积 MP4 背景视频放在用户的 5 TB Google Drive，走流式切片 Range 下载，既不超 R2 10 GB 配额，也不用担心 Google Drive 频繁触发限流！

详细接入 Google Drive 请参见 [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md)。

## 免责与边界

本项目只镜像官方**公开**的曲库读取端点，不绕过认证、不修改官方服务、不重新分发账号数据；客户端更新包与投稿内容一律原样转发官方源，不在镜像落盘。
