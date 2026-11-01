# 稳定性问题

这些问题不直接省钱，但常在排查 Cloudflare 用量时发现。部分做法来自 TanStack Start 项目，其他框架按原理调整。

- **偶发 500**：用 `$metadata.requestId` 拉同一请求的全部日志。如果只有请求记录、没有报错内容，说明框架把异常吞掉，渲染成了错误页（TanStack Start/Router 的 errorComponent 就会这样），要在默认错误组件里加服务端日志。
- **临时存储错误只对只读操作重试一次**（写入不重试，避免重复写）：
  - D1：`storage caused object to be reset`、`Network connection lost`、`reset because its code was updated`、`D1 DB is overloaded`、`transient issue on remote node`
  - R2：`Reduce your rate of simultaneous reads on the same object (10058)`
  - 判断只读：SQL 以 `SELECT` / `WITH` 开头。
- **部署后旧页面报错**：还开着的旧标签页调用已删除的 server function，会拿到通用 500。解决办法：构建时生成一个构建号，同时注入客户端和 Worker（Vite `define`；Vite 配置在每个构建环境各执行一次，构建号要放在 `process.env` 上共享）。Worker 在 server function 响应里加构建号响应头，客户端包一层 fetch，发现构建号不一致就刷新一次，并用 sessionStorage 防止循环刷新。
- 线上复现时用相同的 UA 和 Accept 头，加 `?cb=随机数` 绕过缓存。
