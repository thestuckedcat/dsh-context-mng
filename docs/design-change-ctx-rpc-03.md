# 设计变更单 CTX-RPC-03：浏览器↔Host 传输改用 rc.5 exact Fetch routes

版本：CTX-CHANGE-2；日期：2026-11-07；状态：已实现，隔离 rc.5 Host 实测通过（Chromium 页面旅程未执行）；影响 ID：CTX-02、CTX-04、CTX-06。

## 1. 背景与实测事实

CTX-DESIGN-2 §5.1 依据 rc.5 `dsh-client-connection/lib/index.js` 源码行 724—728、855—871、910 认定
`ctx.connection.rpc.handle(channel, handler)` 可由 profile 插件注册，并称“注册绑定当前 fiber”。实现阶段在
**隔离 rc.5 Host（真实安装字节抽取，真实 web 服务 + 真实浏览器 cookie 认证）** 中验证后确认：

1. `connection.rpc.handle(...)` 从外部 profile 插件调用必然抛出
   `Error: cannot get property "webServer" without inject`。
   失败点在 rc.5 `dsh-client-connection` 的 `register()`：`owner.effect(() => owner.webServer.register(route), ...)`
   中的 `owner` 是 connection 服务自身的 context，它只 inject 了 `credentials`，没有 `webServer`；
   cordis 4.0.5 的服务属性访问强制要求调用上下文声明 inject。
2. 尝试过的三种调用上下文均失败：插件自身 ctx；`ctx.inject(['webServer'], webCtx => ...)` 的 webCtx；
   插件 inject 列表直接声明 `webServer`。因此不是加 inject 能解决的问题，该 seam 在当前字节下不可用。
3. 实际可用 seam 是 `ctx.connection.fetch.register(route)`（上游 dsh-context 0.82.1 也使用它）：
   注册 `{path, methods, requestBody, fetch}`，路由由 connection 的共享 `/api` Fetch handler 服务；
   该 handler 在调用路由前完成 Host/Origin 围栏与认证，并对 `peer.principal.kind !== "owner"` 直接返回 403。
4. rc.5 的 exact Fetch route 只接收 `request`，不接收 `peer` 对象；owner 结论由 Host 共享 handler 先行做出。

## 2. 变更内容

- 新增 `src/transport.mjs`：把四个业务端点注册为 exact Fetch 路由：
  - `POST /api/context-mng/context.list`
  - `POST /api/context-mng/observation.get`
  - `POST /api/context-mng/group.read`
  - `POST /api/context-mng/report.export`
- 请求体仍是 CTX-RPC-01/02 的严格 JSON 外壳；响应体**直接**是 BusinessResponse
  （不再包在 RpcResult 的 `{ok:true,value}` 里，因为不再经过 Connection RPC envelope）。
- 认证/调用者：Host 的共享 `/api` handler 已完成 owner 门禁（非 owner 403，未认证 401），
  然后才调用路由。路由把该 Host 结论记录为 `caller = {kind:'owner', peer_id:'host-owner-gate'}`；
  若未来 Host 版本向路由传入 peer，则直接使用 peer 并保留 `src/rpc.mjs` 的 owner 复核。
  这仍然**不是**从 JSON 读 caller/grant：请求体任何 caller/principal 字段都会被严格 schema 拒绝。
- `src/rpc.mjs`、`src/access.mjs`、BusinessResponse、reason code、严格 schema、响应大小上限、
  catch-all→INTERNAL_FAILURE 全部保持 CTX-DESIGN-2 的语义，不因传输替换而放宽。

## 3. 与 CTX-RPC-01 的差异和保留

| 项 | CTX-DESIGN-2 | 本实现 |
|---|---|---|
| 注册 API | `ctx.connection.rpc.handle('/local-context', handler)` | `ctx.connection.fetch.register(route)` ×4 exact `/api/context-mng/*` |
| 请求外壳 | 同一 JSON 外壳 | 不变 |
| 响应外壳 | RpcResult.value = BusinessResponse | 直接 BusinessResponse（HTTP 200） |
| transport 失败 | RpcResult `{ok:false,error}` 或 throw | 非 2xx / JSON/schema 失败 → 客户端固定 TRANSPORT_FAILURE |
| caller 来源 | 处理器第 4 参 peer.principal | Host 共享 handler 的 owner 门禁（403）+ 恒 owner caller 标记；不从 JSON 读 |
| 业务拒绝 | value 内固定 status/reason_code | 不变（HTTP 200 + 固定 BusinessResponse） |
| 异常 | catch 全部异常→INTERNAL_FAILURE | 不变 |

## 4. 证据

隔离 rc.5 Host（DSH_HOME 工作区内隔离，web profile，真实 cookie 认证）实测：

- `context.list` → 200 `{"status":"ok","data":{"contexts":[...]}}`（仅登记绑定、无路径/正文）
- 已登记但无 live session 的 `observation.get` → 200 `{"status":"unavailable","reason_code":"SESSION_UNAVAILABLE"}`
- 请求体伪造 `caller` 字段 → 200 `{"status":"invalid","reason_code":"INVALID_REQUEST"}`
- 未知 endpoint → Host 路由层 404
- `group.read`（未知 observation）→ 200 `{"status":"stale","reason_code":"STALE_OBSERVATION"}`
- `report.export`（未登记 output_ref）→ 200 `{"status":"denied","reason_code":"OUTPUT_REF_DENIED"}`
- 未认证请求 → 401 `unauthorized`（Host 在插件之前拒绝）

组件测试：`tests/transport.test.mjs` 11/11 通过（路由形状、直接 BusinessResponse、owner 门禁记录、
非 owner peer 拒绝、错误 content-type/JSON、声明长度/chunked 超限、流错误、异常固定失败、dispose、
无绝对路径泄露）。

## 5. 未关闭缺口与回退

- **未执行**：真实 Chromium 页面中的面板渲染、轮询、切换会话与导出用户旅程；浏览器侧 client.js 的
  真实模块加载未在 GUI 验证（仅 Node 合同测试）。
- rc.5 exact route 不传 peer 身份，属于 Host 侧信息缺口；当前以 Host owner 门禁 + registry 作为边界，
  已在证据中标注。若 Host 升级提供 peer 或修复 `rpc.handle`，传输层可回退到 CTX-RPC-01 形态，
  业务层与访问控制无需改动。
- 回退方法：删除 `src/transport.mjs` 与 `index.js` 的 transport 注册，客户端改回 `ctx.connection.rpc.call`；
  registry、service、rpc、schema 与测试不受影响。

## 6. 复审后补正（2026-11-07，CTX-REVIEW-1）

独立复审（`docs/implementation-review.md`）指出：原 exact routes 以 `requestBody:"buffered"` 注册，
请求体在插件检查前已由 Host 缓冲（默认上限 300 MiB），设计 §5.1 要求验证全局 body 上限、事后长度检查
不能作为传输层分配证明。补正如下：

- 四个 exact route 改为 `requestBody:"streaming"`；rc.5 `bridge()` 只有 `"buffered"` 才预缓冲，其余值使用
  `Readable.toWeb(req)` 的流式 Request；
- `src/transport.mjs` 新增 `readJsonBody(request, maxBytes)`：带 `content-length` 超限在读前拒绝；chunked/
  流式 body 读到 64 KiB 即 `cancel()` 并返回固定 `LIMIT_EXCEEDED`；JSON 解析失败固定 `INVALID_REQUEST`；
  rpc handler 的事后长度检查保留为纵深防御；
- 隔离 rc.5 Host 重跑：声明 ≈70 KB 与 chunked ≈70 KB 两种请求均返回 200 + `LIMIT_EXCEEDED`，其余拒绝路径
  不变（`evidence/task4-host-rpc.txt`）；`tests/transport.test.mjs` 11/11。

该补正不改变请求/响应外壳、owner 门禁、registry 授权或错误码语义；回退时同时恢复 `requestBody` 与 reader。
