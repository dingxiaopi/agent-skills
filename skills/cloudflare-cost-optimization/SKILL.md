---
name: cloudflare-cost-optimization
description: "Cloudflare 成本优化：在功能不变的前提下，把部署在 Cloudflare（Workers / D1 / R2 / KV / Cache API）上的项目的费用降到最低，顺带提升性能。已上线的项目用真实用量数据找出最贵、最慢的请求和查询；还没上线的项目从代码和本地数据库提前检查。适用于：想知道账单从哪来、D1 读取量偏高、Workers 请求量或 CPU 偏高、页面慢、静态文件误走 Worker、爬虫流量大、上线前做一次检查、上线新功能后确认有没有性能问题。用户说“查一下 Cloudflare 用量/费用/性能”“D1 读取太多”“有没有无意义查询”“上线前帮我看看 Cloudflare 开销”时使用。Cloudflare cost optimization for Workers/D1/R2, with performance as a side benefit: requests, CPU, D1 rows read/written, caching, static assets, bot traffic, pre-launch review."
---

# Cloudflare 成本优化

目标：**功能不变，用最低的成本实现。** Cloudflare 按量计费，所以就是让计费项（Worker 请求、CPU 时间、D1 读写行数、R2 操作次数、日志量等）尽量少。

性能是顺带的收获：少查一次数据库、少渲染一次页面，既省钱又更快。两者冲突时以成本为准；为了提速要多花钱的方案（更高套餐、付费功能等），必须先问用户。

核心原则：能测就测，改写前后用同一种方法对比；不凭印象估算，不用付费升级掩盖低效代码。

## 0. 边界（先读）

- 可以直接做：读代码、本地运行和查询本地数据库、只读的线上查询（`wrangler d1 insights`、`d1 execute --remote` 跑 SELECT、控制台指标和日志）。
- 必须先问用户：改 Cloudflare 设置（WAF、缓存规则、DNS、路由、R2 CORS）、写线上 D1/R2/KV、远程迁移、开通付费或预算通知、建定时任务。
- 价格、包含额度和套餐都会变，也因账户而异：**每次运行时查官方价格页，并确认当前项目用的是什么套餐**，不凭记忆写数字，也不假设用户的套餐。价格页：[Workers（含日志）](https://developers.cloudflare.com/workers/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[KV](https://developers.cloudflare.com/kv/platform/pricing/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Queues](https://developers.cloudflare.com/queues/platform/pricing/)、[Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[Images](https://developers.cloudflare.com/images/pricing/)、[Stream](https://developers.cloudflare.com/stream/pricing/)。
- 这份清单是通用方法，部分结论来自单个项目的实测（标了“实测”的），应用前用 rows_read 等数据在当前项目复核。
- 汇报时把“已实现 / 已验证 / 已上线 / 推算”分开写。

### 术语速查（汇报时可以照这个解释给用户）

| 术语 | 大白话 |
|---|---|
| 按量计费 | 用多少付多少，Cloudflare 按请求次数、CPU 时间、数据库读写行数等收费 |
| 包含额度 / 免费额度 | 每月套餐里白送的量，用完才另外收费 |
| 计费项 | 具体按什么收钱，例如 Worker 请求数、D1 读取行数 |
| Worker 请求 | 访问者每打开一个页面、加载一张经过 Worker 的图片，就算一次 |
| CPU 时间 | 服务器为一个请求实际干活的时间 |
| D1 读取行数 | 数据库每次查询翻了多少行数据，翻得越多越贵 |
| 静态资源 | 图标、脚本、样式这类不变的文件，直接由 Cloudflare 发出去，不经过 Worker，不计请求费 |
| 边缘缓存 | 把算好的页面暂存在离访问者近的 Cloudflare 节点上，下次直接给，不用再查数据库 |
| 索引 | 数据库的“目录”，查询走对了索引就不用一行行翻 |

## 1. 先判断项目处在哪个阶段

- **已上线、有流量**：按第 2 节拿真实数据，从最贵、最慢的项开始处理，再用第 4 节的清单补查。
- **还没上线或没有流量数据**：按第 3 节做上线前检查，再过一遍第 4 节的清单。上线一到两周后，再按第 2 节用真实数据复核一次。

## 2. 已上线：用真实数据找问题

### 第一步：先算钱，再决定做不做

1. 确认项目用的套餐，只看它实际用到的产品（`wrangler` 配置里的 bindings 就是清单）。
2. 列出每个计费项的“本月用量 / 包含额度 / 占比 / 超出部分 / 按当前单价折合多少钱”。用量取自控制台或下面的接口，单价取自官方价格页。
3. 按结果决定下一步：
   - **有超额**：从花钱最多的一项开始处理，每项改动都估算能省多少钱。
   - **都在额度内**：如实告诉用户现在没有多花钱。只修明显的 bug（比如每个请求都多跑几条查询）和增长很快、快要超额的项，其余列出来，写明到什么用量再做，**不继续为优化而优化**。

### 第二步：拉数据

先用自带的两个脚本，在 `scripts/` 下。它们是只读的，只用 Node 18+ 自带的功能，macOS、Linux、Windows 都能运行。在项目目录里运行，脚本才能用上项目里安装的 wrangler。

```bash
node <skill目录>/scripts/cf-usage.mjs usage --since <计费周期开始日>     # 全账户：Workers、D1、R2、KV 用量
node <skill目录>/scripts/cf-usage.mjs worker <Worker名> --since <日期>   # 单个 Worker：按天、按版本、按结果、按小时
node <skill目录>/scripts/tail-summary.mjs <Worker名> --seconds 300       # 实时采样 5 分钟：CPU 花在哪些路径、哪些客户端
```

- **没有登录时**：脚本提示找不到令牌时，请用户自己做以下任一项，再重跑脚本：
  - 运行 `npx wrangler login`，在打开的浏览器页面里登录 Cloudflare 并点“允许”；
  - 在控制台创建只读的 API 令牌，权限选 Account Analytics Read，设到环境变量里。

  授权必须由用户本人完成：不要代替用户输入 Cloudflare 账号密码，也不要让用户把令牌粘贴到对话里。
- **令牌**：优先用环境变量 `CLOUDFLARE_API_TOKEN`，需要 Account Analytics Read 权限；没有就用本机 `wrangler login` 存下的登录令牌，不用另外申请。登录令牌约 1 小时过期，脚本提示过期时，让用户运行一次 `npx wrangler whoami` 刷新。账号有多个时，加 `--account <id>`。
- **计费周期**：`--since` 填本期开始日。开始日看控制台账单页（续订日），不要默认用自然月。脚本只给出用量，包含额度和单价按第 0 节去价格页查。
- **代理**：Node 自带的 fetch 不读代理环境变量。设了 `HTTPS_PROXY` 时，脚本会借用项目里 wrangler 自带的 undici 走代理；也可以用 Node 24+ 加 `NODE_USE_ENV_PROXY=1`。
- **怎么读 `worker` 的结果**：
  - 按版本看每次请求的平均 CPU，某次发版后突然变高，问题多半出在那次发版。
  - 每小时 CPU 平稳、请求数却忽高忽低，说明有持续的后台负载，常见原因是爬虫在抓没缓存的页面。
  - 免费版单次 CPU 上限只有 10 ms，升级前的数字会偏低，前后不能直接比。
- **怎么读 `tail-summary` 的结果**：
  - 看每类路径的 CPU 占比和“不同网址数 / 请求数”。两者接近，说明访问很少重复，页面缓存帮不上忙，要从降低单次渲染成本入手。
  - 很多不同省份的住宅网络、用浏览器 UA 挨个翻同一类页面，像分布式抓取，按 IP 限流挡不住。
  - 采样只看比例，不要外推成精确的月度数字。
  - 原始事件含 IP 和请求头，脚本默认不保存；加 `--save` 才保存，保存的文件不要外传。
- **GraphQL 的坑**：
  - 查询太频繁会报 “budget depleted”，要等约 5 分钟，所以尽量合并成一次查询。
  - 维度和字段以报错提示为准，比如 Workers 数据集没有 `datetime` 维度。
  - 自适应数据集只能回看有限天数。
- **wrangler 登录令牌查不了 Observability 接口**（返回 403）。按路径、UA 分组要用有权限的 API 令牌、控制台页面，或上面的 `tail-summary`。
- **测缓存时看 `cf-ray` 结尾的机房代码**：缓存按数据中心分别存，代理或网络切换机房后，第一次 MISS 是正常的，不能据此判断缓存没生效。

如果脚本报错，或者需要脚本没覆盖的数据，再按下面的方式手动查：

- **日志要先开启**：Workers Logs 需要在 wrangler 配置里设 `observability.enabled: true`，否则查不到请求明细。开启并部署后才开始积累，只保留数天（当前期限看官方文档），日志量也计费。没开就告诉用户，由用户决定是否开启。
- **没有浏览器时用接口**：GraphQL Analytics API（`POST https://api.cloudflare.com/client/v4/graphql`，令牌需要 Account Analytics Read 权限）：
  - Workers：`workersInvocationsAdaptive`（`requests`、`errors`、`cpuTimeP50`、`cpuTimeP99` 等）
  - D1：`d1AnalyticsAdaptiveGroups`（`rowsRead`、`rowsWritten`）、`d1QueriesAdaptiveGroups`（单条查询）、`d1StorageAdaptiveGroups`（存储）
- 令牌让用户放在环境变量里，不要粘贴到对话或写进报告；日志里的 IP、Cookie 等也不要原样写进报告。

### 第三步：D1 哪些查询最贵、最慢

`wrangler d1 insights` 是实验性命令，参数和输出可能变化，数据最多查 31 天；报错时看 `--help` 或改用上面的 GraphQL。

```bash
wrangler d1 insights <DB> --timePeriod 7d --sort-type sum --sort-by reads --limit 25 --json     # 读取最多
wrangler d1 insights <DB> --timePeriod 7d --sort-type sum --sort-by count --limit 50 --json     # 执行最频繁（找每个请求都跑的小查询）
wrangler d1 insights <DB> --timePeriod 7d --sort-type sum --sort-by writes --limit 25 --json    # 写入最多
wrangler d1 insights <DB> --timePeriod 7d --sort-type avg --sort-by time --limit 25 --json      # 平均最慢
```

- 看 `totalRowsRead`、`numberOfTimesRun`、`avgRowsRead`、`avgDurationMs`，把每条 SQL 对回代码里的功能，列成“来源 / 7 天读取 / 次数 / 平均每次 / 判断”的表。
- 短窗口（1h、2h）的数据有延迟、不完整，只能看相对比例。复核时用多个窗口对比，或者等 24h、7d。

### 第四步：Workers 请求从哪来

- 先跑 `tail-summary.mjs` 看比例；需要更长时间范围再用下面两种。
- 控制台 Worker「指标」：调用次数、CPU、错误；静态资源请求单独统计。
- Observability（控制台 Workers → Observability，或 `POST /accounts/{account_id}/workers/observability/telemetry/query`）按字段分组计数：
  - `$workers.event.request.url`（用 `includes` 过滤路径前缀；`$workers.event.request.path` 常为空）
  - `$workers.event.request.headers.user-agent`：谁在刷
  - `$workers.event.request.cf.verifiedBotCategory`：Cloudflare 认证过的爬虫类别
  - `$workers.event.response.status`：404 也要看，404 同样计费
  - `$workers.cpuTimeMs`、`$workers.wallTimeMs`：哪些请求最耗 CPU、最慢
- 按路径前缀算占比（图片 / 页面 / 接口 / 登录 / 统计 / 404），找出最大的几块。
- 控制台和 wrangler 里跑的查询也计入 D1 读取，别反复跑全表查询。

## 3. 还没上线：从代码和本地提前检查

1. **列出每个页面和接口会触发哪些查询。** 重点看首页、列表页、详情页这些访问最多的页面：每次请求跑几条 SQL，有没有全表扫描、全库聚合、`OFFSET` 深分页、多值 `IN`。
2. **在本地数据库上测。** 导入一份接近真实规模的数据，对关键查询跑：
   ```bash
   wrangler d1 execute <DB> --local --json --command "EXPLAIN QUERY PLAN SELECT ..."
   wrangler d1 execute <DB> --local --json --command "SELECT ..."   # 看 meta.rows_read
   ```
   数据量和线上不同，绝对值只作参考，重点看有没有用上索引、改写前后的相对变化。
3. **检查静态资源配置**（第 4.1 节）：favicon、robots.txt、图片、字体等是否直接由静态资源返回，不经过 Worker。
4. **检查缓存设计**（第 4.4 节）：公开页面和全库统计有没有缓存，缓存时间是否合理。
5. **检查每个请求都会执行的代码**：有没有每次都新建数据库客户端、认证实例，有没有每次都写日志或写统计。
6. **检查定时任务和后台任务**：cron 频率是否必要，有没有每次都扫全表。
7. **想清楚图片放哪**：上线前决定图片走 R2 自定义域名还是经 Worker 返回，比上线后改地址简单（见第 4.5 节）。

## 4. 优化清单（按计费项）

### 4.1 Worker 请求：本该是静态文件的别走 Worker

静态资源请求不按 Worker 请求计费，而且更快，但前提是请求真的命中了静态文件。下面这些常见请求如果没有对应的静态文件，就会进 Worker、渲染出 404 页面，每次都算一次 Worker 请求，还要耗 CPU：

- **`/favicon.ico`**：浏览器和爬虫会自动请求，即使页面里用的是 svg 图标。放一个静态的 `favicon.ico`，用几个尺寸的 PNG 合成即可。
- **`/robots.txt`、`/sitemap.xml`**：内容固定就做成静态文件；需要动态生成的，加长缓存。
- **`/apple-touch-icon.png`** 等常被自动请求的图标。
- 确认静态文件放在构建工具真正发布的目录，例如 Vite 的 `publicDir` 可能被改成了别的目录名。
- 确认没有配置让所有请求都先进 Worker（例如 `run_worker_first`），除非确实需要。
- 用 Observability 按 404 分组，看还有哪些高频 404 进了 Worker，比如旧地址、扫描器探测的 `/wp-admin`、`.env`。

### 4.2 D1 读取

按**扫描的行数**收费，与每行多大、返回多少行无关：过滤条件没走索引时，只返回 1 行也可能算扫了几千行。

1. **多值 `IN (...)` / `NOT IN (...)`**：超过约 2 个值时，SQLite 会建临时表，D1 对每行多算一次读取，实测读取量约翻倍。固定的小名单改成 `col<>? AND col<>? ...` 或 `=` 链，再用 rows_read 确认。
2. **选错索引**：多条件查询时，SQLite 可能挑了区分度低的索引，扫掉大量无关行。用一元加号 `+col = ?` 让某列不参与索引选择，引导它走更合适的索引，读取量可能降一个数量级。同一个改写可能让另一种排序反而变贵，所以每种排序和筛选组合都要单独测，保留各自最优写法，并加测试锁住查询计划。
3. **全库聚合缓存太短**：分类计数、排行、目录统计这类 GROUP BY 全表的查询，Cache API 是**按数据中心**缓存的。5 分钟有效期意味着每个数据中心每天最多重算 288 次。改成 1 小时左右，列表和详情保持短缓存，并说明代价：计数最多晚 1 小时更新。
4. **深分页 `OFFSET`**：越往后越贵，主要是爬虫在翻。根治是游标分页，但会改 URL、影响 SEO，要用户决定。
5. **每次请求新建 ORM 或认证实例**：有的库在新建实例时会检查表结构（`sqlite_master` + `pragma_table_info`），等于每个请求都多跑几条查询，还拖慢响应。例如 Better Auth 每次 `betterAuth({...})` 都会检查。解决办法：实例在 isolate 内复用（模块级 `runtime ??= create()`）；表结构由迁移管理时，关闭运行时检查（Better Auth：`advanced.database.validateSchema: false`）。在 insights 里按 count 排序最容易发现。
6. **计数和排序分开**：count 与排序无关，统一用最便宜的写法构造。
7. **查询都要有上限**：列表必须 `LIMIT`，否则数据一多读取量就跟着涨。
8. **加索引前算写入**：索引能减少读取，但每次写入都要多写索引行。读多写少的表通常划算，写多读少的表要先算一下。

### 4.3 D1 写入与 CPU

- 写入的单价远高于读取（写这份文档时同样行数约差 1000 倍，以价格页为准），写入量不大也可能比读取更贵。检查每个请求都会写的东西：访问统计、限流计数、会话刷新。能合并就合并，能过滤爬虫就过滤，失败了不要自动重试写入。
- CPU 主要耗在 SSR 渲染和大 JSON 序列化上。公开页面做边缘缓存，就能省掉这部分（见下一节）。
- **只取需要的字段**：不对正文、JSON 这类大字段 `SELECT *`。这不减少 D1 读取费用（按行计），但能省 CPU 和传输时间。
- **Worker 等待的时间不收费，只收 CPU 时间。** 所以把查询改成并行不会省钱，不要当成省钱手段。D1 每个数据库是单线程，一次处理一条查询；`Promise.all` 只是同时发出去，到数据库还要排队。
- **`db.batch` 不是并行**：它按顺序执行，而且是一个事务，其中一条失败，整批都会失败并回滚。它能减少网络往返，适合本来就该一起成功或失败的语句；不要把互不相关的查询硬塞进去，否则一条出错会连累其他查询。
- 付费版要提高单次 CPU 上限时，在 wrangler 配置里设 `limits.cpu_ms`，并确认构建产物（如 `dist/server/wrangler.json`）保留了这个值。上限只是防止请求被中途掐断，不能代替优化。

### 4.4 缓存：让重复请求不再执行代码

- 公开页面用 Cache API 做边缘缓存：只缓存 200、没有 Set-Cookie、没有登录态的请求；带会话或 Authorization 的请求一律绕过缓存。
- 缓存键带部署版本号（`env.CF_VERSION_METADATA.id`），避免新版本拿到引用旧静态资源的 HTML。
- 过期后先返回旧内容、后台刷新（stale-while-revalidate），访问者不用等；刷新结果不是可缓存的 200，就删掉旧条目。
- 缓存键里带 utm 等追踪参数会产生重复缓存；但直接忽略这些参数，可能导致 SSR 序列化的路由状态和实际 URL 不一致，要先评估再改。
- 注意：Cache API 命中前要先执行 Worker，所以仍算一次 Worker 请求，只是省掉了查询和渲染。Workers 自带的 Caching 功能命中后同样按请求计费，省的是 CPU。

### 4.5 图片 / R2

- 图片经 Worker 返回，每张都算一次 Worker 请求，边缘缓存命中也算。改走 R2 自定义域名（如 `img.example.com`）可以去掉这部分请求，但**速度基本不变**，因为两条路都有边缘缓存。新域名首次访问还要多一次 DNS 和 TLS 握手，可以用 preconnect 弥补。请求量在包含额度内时，改了也省不了钱。
- R2 自定义域名对 GET 请求会缓存（第一次 MISS，之后 HIT）。用 `curl -I`（HEAD）测会看到 `DYNAMIC`，容易误判成不缓存。测缓存一律用 GET。
- 封面、列表图提供小尺寸版本（如 360/720/1080 宽的 webp），用 `srcset` 按屏幕选择，既省流量又更快。
- R2 读取按操作次数计费，没有缓存的高频图片要注意。
- 页面要把图片画到 canvas 上（例如分享海报）时，跨域图片需要 R2 配 CORS；这部分图片保持同域，就可以不配。

### 4.6 爬虫流量

- User-Agent 是爬虫自己填的，可以伪造。Cloudflare 的 `verifiedBotCategory` 表示认证过的爬虫（搜索引擎、AI 助手等），未认证的名字只能参考。
- 先用 robots.txt 点名禁止没有价值的爬虫，改代码即可；不守规矩的，再用 WAF 规则拦截（要用户同意）。
- 搜索引擎和会带来读者的 AI 助手（例如 ChatGPT-User、PerplexityBot）一般保留。
- 伪装成普通浏览器的高频访问不要贸然封，避免误伤真人。

### 4.7 其他计费项

- **日志**：Workers Logs / Observability 超出包含量后可能计费，日志量大时可以配置采样率（`observability.head_sampling_rate`）。正常请求别每次都 `console.log` 大对象。
- **KV**：写入和列举比读取贵，不要每个请求都写 KV。
- **其他产品**：项目用到 Durable Objects、Queues、Workers AI、Images、Stream、Hyperdrive 等时，同样查价格页、看用量，找到最贵的那一项。这份清单没有细写它们，不要套用 D1 的结论。
- **免费版**：额度按天或按月计算，单位和付费版不同，超出时通常是请求报错而不是产生账单。先确认项目的套餐，再解读用量。

## 5. 附带：稳定性问题

偶发 500、存储临时错误、部署后旧页面报错不直接省钱，但常在排查时发现。遇到时读 [references/stability.md](references/stability.md)。

## 6. 改完之后

1. 类型检查、测试、生产构建通过后再部署，记下版本号和回滚点。
2. 上线后检查关键页面是否 200、重定向和缓存头是否正确，静态文件（favicon 等）是否不再进 Worker。
3. 用同样的方法复核：当天用多个时间窗口的比例确认方向，一周后用 7d 数据确认幅度。
4. 写记录：范围与方法（数据来源、时间窗口）→ 用量和分布表 → 每个问题的“原因 / 修复 / 修复前后实测值” → 预计效果（标明是推算）→ 检查与发布（版本号、回滚点）→ 看过但没处理的项及原因。

## 7. 怎么跟用户汇报

- **用大白话，先说结论。** 用户可能不熟悉 Cloudflare 和数据库，少用术语；必须用时顺带解释一句（例如“D1 读取行数：数据库每次查询翻了多少行数据，按这个计费”）。
- 先说清现在每月多花多少钱、占额度多少。额度远没用完时，优化的价值是控制增长、留出余量、修掉随访问量放大的问题，**不是马上省钱**，要如实说明。
- 每项建议都写预计能省多少钱（标明是推算）。省不了钱的改动（例如额度内把图片改走 R2 域名），给出“现在不做、到什么用量再做”的建议。
- 需要用户决定的事（改 Cloudflare 设置、改网址结构、付费），单独列出来，说明做与不做各有什么后果。
