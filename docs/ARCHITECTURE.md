# 架构与运维

本文描述当前实现的公开契约、存储布局、同步一致性、代理边界和部署运维。容量数字属于观测值，不是固定承诺；需要预算时运行 `tools/plan-capacity.mjs`。

## 1. 请求模型

```text
RhyDive client
  ├─ /api/rhydive/library, .../download, .../archive, /assets/...
  │    └─ Worker mirror → R2 metadata / R2|Drive bulk
  ├─ /rhydive/beatmap/...  (official download-site surface)
  │    └─ same mirrored objects
  └─ everything else       → official origin, proxied
```

Worker 只将 `GET` 与 `HEAD` 视为可缓存读取。所有其他方法直接转发。路径像资源但未通过扩展名、song id 或路径校验时返回本地 JSON `400`，不会回源。

API 表面未命中时回源，保持未初始化镜像的纯代理行为。下载站表面默认返回 JSON `404`，让官方客户端按自身规则回源；`MIRROR_FALLBACK_PROXY=false` 时也会如此。

## 2. 客户端不变量

这些约束由客户端 `readManifest` 与 `publishArchive` 强制执行：

1. 清单必须 `success: true`，`song.id` 与请求一致，资源数量为 1–5000。
2. 每个 `file.url` 必须精确匹配编码后的资源路径，大小是 0–128 MiB 安全整数，sha256 是 64 位十六进制，名称大小写不敏感唯一。
3. 资源总大小不超过 512 MiB；ZIP 不超过 256 MiB。
4. ZIP 本体 sha256 必须等于清单；解压条目集合必须与清单名称、数量、大小和 sha256 一一对应。
5. 资源响应不得是 `text/html`；Range 和具体 Content-Type 必须正确。

因此镜像不能重打包 ZIP、改写清单文件名或从第二个源拼接资源。客户端契约的取证细节见 [API 文档](API.md)。

## 3. 存储与代次

元数据始终在 R2；bulk 对象可位于 R2 或 Drive。

```text
_catalog/library.json                        当前镜像目录
_catalog/sync-state.json                     队列、失败、上次运行
_catalog/sync-lock.json                      短期同步租约
_catalog/songs/<id>.json                     当前代次指针
_catalog/manifests/<id>.json                 兼容固定路径
_catalog/manifests/<id>/<sha256>.json        不可变清单代次
_objects/archives/<id>/<sha256>.zip          不可变 ZIP 代次
_objects/assets/<id>/<sha256>/<name>         不可变资源代次
<id>.zip                                     旧部署兼容路径
<id>/<name>                                  旧部署/懒加载路径
```

每次成功同步先写齐不可变对象，再切换 `_catalog/songs/<id>.json`。只有指针可见后，该代次才对外发布。下载站请求始终读取已提交代次；旧对象仍在时，正在进行的读取不会被新上传覆盖。下架清理按记录的 `archiveKey` 和 `assetKeys` 精确删除。

### 存储布局

| 布局 | 元数据 | ZIP | 热资源 | 冷资源 |
| --- | --- | --- | --- | --- |
| `r2` | R2 | R2 | R2 | R2 |
| `gdrive` | R2 | Drive | Drive | Drive |
| `hybrid` | R2 | Drive | R2 | Drive |

热资源定义：基础名以 `bg.`、`background.`、`cover.`、`audio.`、`preview.` 开头，或扩展名为 `.osu`。这个定义同时被 Worker 与容量工具使用。

读取先查主层，再查另一层，以便切换布局后仍能读取旧对象。只有真正的“不存在”才能继续尝试下一层；Drive 的鉴权、限流或传输错误会作为服务错误返回，不能被伪装成 404。

### 资源物化

| `SYNC_ASSET_MODE` | 同步时写入 | 请求时行为 |
| --- | --- | --- |
| `all` | 全部资源 | 直接命中 bulk 存储 |
| `hot` | 热资源 | 其余从 ZIP 提取，并可选写穿 |
| `lazy` | 只写 ZIP | 资源按需提取 |

`SYNC_ASSET_SOURCE=origin` 时同步直接拉取所需资源，不必为了热资源下载 ZIP；`archive` 时从同一份 ZIP 解出并逐个校验。懒加载写穿对象带 `generation` 元数据；旧代次缓存不会在新清单发布后被误用。

## 4. 同步

一次 tick：

1. 获取配置源的目录；异常记录在本次运行错误中，不覆盖已有镜像目录。
2. 比较官方 `archiveHash` 与已发布记录，生成待同步、待删除队列。
3. 在每首开始前检查歌曲数与墙钟预算。
4. 拉取清单与 ZIP，校验 ZIP 大小和 sha256；校验所有清单路径与条目存在性。
5. 只物化策略要求的资源，并逐项验证大小和 sha256。
6. 写入不可变对象，切换代次指针。
7. 清理已下架曲目并写回状态。

失败曲目保留在队列中并按 1 分钟起、6 小时上限的指数退避重试。状态保存使用 ETag 条件写；竞争写入会报告冲突，不会静默覆盖较新的进度。完整官方目录另存于 `_catalog/official-library.json`：`skipCatalog=true` 的轮次只读 R2 缓存，仍会重新生成完整镜像目录并把本轮新完成曲目发布出去；定期刷新轮次重新拉取官方目录，用于发现新歌、下架和上游更新。

### 并发控制

cron、`/__admin/sync` 和外部灌库脚本共享 `_catalog/sync-lock.json`。租约通过 R2 条件写获取，按预计 tick 时长续租；第二个同步启动会收到 `409 sync_busy`。过期租约允许接管，正常完成或失败都会尝试释放自己持有的租约。

锁只保证同步任务同一时刻一个执行者，不能替代事务。因此状态仍有独立的 ETag 校验，代次发布也通过“先对象、后指针”的顺序保证可恢复性。

### 来源与哈希

`SYNC_SOURCE=api` 读取 `sta.lunprin.com/api/rhydive/...`；`cdn` 读取 `dl.lunprin.com/rhydive/beatmap/...`。同步只读所配置的源，源之间的延迟会表现为该曲留队重试，而不是静默换源。

官方目录的 `archiveHash` 可能是歌曲首发哈希而清单/归档已是新字节。默认 `SYNC_HASH_MODE=manifest` 以实际 ZIP 为准，并在镜像目录里改写该曲 `archiveHash`；`strict` 则保留已同步对象但不发布这类曲目。两种模式都不会发布目录、清单和 ZIP 相互矛盾的组合。

## 5. 代理

`proxyRequest()` 保留请求方法、路径、查询、流式请求体和上游状态。处理包括：

- 去除逐跳头并设置 `x-forwarded-*`。
- 请求上游 `accept-encoding: identity`，避免自动解压后仍带压缩元数据。
- 保留多条 `Set-Cookie`，剥离上游 `Domain`；回环开发主机额外去掉 `Secure`。
- 对可信来源返回精确 Origin 与凭据权限，其他来源不使用凭据。
- 204、304 与 HEAD 使用空 body。

官方源重定向不自动跟随：同步客户端显式拒绝 3xx；代理按 HTTP 语义原样返回给客户端。

## 6. Google Drive

Drive 驱动使用账号 OAuth refresh token 与 `drive.file` 权限。对象名是完整 URL 编码 key，存在一个配置或自动创建的文件夹中。令牌缓存和文件夹 ID 存在 R2 内部前缀。

授权：

```bash
node tools/gdrive-auth.mjs --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```

这个脚本打开 `http://127.0.0.1:53682` 回调，终端打印 refresh token。不要提交 token 或 `.dev.vars`。

My Drive 与共享盘的区别：

- My Drive 列表不发送 `driveId`。
- 设置 `GDRIVE_TEAM_DRIVE_ID` 后，列表使用 `corpora=drive` 与 `driveId`。
- 创建文件夹时若使用共享盘，新文件夹直接放入共享盘的 `parents`。

Drive 的冷读取成本、配额和下载限制是其作为 bulk 层的主要风险。Google 不将 Drive 定位为公共 CDN；不要把 Drive 当成 R2 的同等低延迟替代品。

## 7. 配置与部署

完整变量见 [`worker/wrangler.toml`](../worker/wrangler.toml) 与 [`worker/.dev.vars.example`](../worker/.dev.vars.example)。

```bash
cd worker
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run
npx wrangler r2 bucket create rhydive-mirror
npx wrangler secret put SYNC_TOKEN
npx wrangler deploy
```

首次灌库：

```bash
node tools/sync.mjs --worker https://<worker> --token "$SYNC_TOKEN"
node tools/verify-mirror.mjs --worker https://<worker> --deep
```

`sync.mjs` 遇到 `409 sync_busy` 会等待并重试，控制面 HTTP 429/502/503/504 和传输错误按有界指数退避重试，单次请求有硬超时。默认每 20 轮刷新一次官方目录，其余轮次传 `skipCatalog=true` 使用 R2 缓存；可用 `--catalog-every` 调整。队列仍非空时脚本以非零状态退出。`verify-mirror.mjs` 检查健康、目录、清单限制、ZIP 哈希、条目集合、资源哈希、Range、下载站表面、代理与路径穿越。

## 8. 运行与诊断

| 端点 | 用途 |
| --- | --- |
| `/` | 服务与端点摘要 |
| `/__health` | 配置与存储可用性 |
| `/__admin/status` | 队列、失败、代次、存储分层统计、Drive 配额 |
| `/__admin/sync` | 单次手动同步；支持 `songs`、`budgetMs`、`skipCatalog` |
| `/__admin/catalog` | 从官方目录重建镜像目录 |

`storage.storedByTier` 按对象所属层统计已物化字节；`logicalBytes` 是客户端读取目录内全部曲目的逻辑总量，不等于 R2 账单。write-through 产生的新资源不会立即计入该同步统计，实际账单仍以 Cloudflare 与 Drive 控制台为准。

常见问题：

- `text/html`：客户端会拒绝，服务端应返回 JSON 错误。不要用托管商默认 HTML 错误页替代 Worker。
- 404 与 5xx：客户端只在 404 时回源。Drive 限流或 R2 故障不应伪装成 404。
- 同步卡住：查看 `409`、`lastRun`、`failures` 与租约过期时间；不要同时运行多个灌库脚本。
- 发布后资源不一致：检查 `_catalog/songs/<id>.json` 指针、代次对象和清单哈希；旧固定路径只用于兼容，不是发布依据。
- 容量超限：运行容量工具而非依赖固定文档数字；注意 ZIP + 全部资源约等于两份 bulk 数据。

## 9. 验证边界

- 单元/集成测试使用可控假源，覆盖同步、并发、布局切换、代理、路径校验、Drive 行为与真实样本离线全链路。
- `test/live.test.ts` 需要真实网络，属于显式 opt-in。审计时 API 源与下载站源均已通过真实歌曲链路；下载站明显更快。
- Wrangler 4 + workerd 已实际启动，从空 R2 同步真实样本并通过深度客户端验收；`wrangler deploy --dry-run` 另验证打包与配置。
- Wrangler 3 在当前 Node 24 环境曾触发原生启动崩溃；升级到 Wrangler 4.151.1 后已消除。不要用旧工具链复现部署。

## 10. 已知边界

- 只处理官方公开曲库；认证端点和写入端点是转发而非镜像。
- 新增曲目在下一个成功 tick 后进入镜像目录。
- 未实现跨区域强一致性；R2 与 Drive 的延迟和错误率必须按外部依赖处理。
- 当前工作区包含旧版兼容路径与旧状态字段，用于平滑迁移；新写入以代次指针为准。
