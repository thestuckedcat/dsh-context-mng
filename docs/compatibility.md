# 07 宿主兼容性与已验证接口

版本：CTX-COMPAT-1；日期：2026-11-07。本文只记录**实际从本机已安装字节读取并核对**的事实，以及由此确定的接缝。设计文档中的行号/哈希若与此冲突，以本文的实际字节为准；未实际运行的接口标为“已核源码，未运行”。

## 1. 基线身份

| 项 | 实际值 | 证据 |
|---|---|---|
| 已安装 Harness | `0.2.1-rc.5` | `E:\dsh\resources\app.asar` 内 `dsh/package.json`：`@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.5；全部 `@deepseek-ai/*` 依赖同为 0.2.1-rc.5 |
| Electron | 44.7.0 | `E:\dsh\version` |
| app.asar | 182,766,714 bytes | 本机文件 |
| 本机 Node（实现/测试） | v26.13.0；npm 11.20.0；pnpm 12.16.1 | `node --version` |
| 设计基线 Node | Node 24.9+ | 本机默认 Node 26.13.0；门禁复跑使用 Electron-as-Node **v24.18.1**（Electron 43.3.0），178/178 通过（`evidence/task5-node24.tap`）。Node 24 GUI 未运行 |
| 另一个本地源码 | `E:\dsh-web\deepseek-harness` @ `ce7073d…`，package 0.2.2-alpha.2 | **不当作现用 Host**，只作只读参考 |

固定文件 SHA256（从 app.asar 只读抽取后计算，与 `docs/software-design.md` 设计表一致）：

| 文件 | SHA256 |
|---|---|
| `dsh-client-connection/lib/index.js` | `0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684` |
| `dsh-client-connection/lib/client.browser.js` | `dfc3544eb894c74b340a4c4c63a8c125fd2e983df9efed5885712574af994e62` |
| `dsh-client-ui-layout/lib/client.js` | `eb011a7b5699fac7f3ad0aa15408f46a6cf47f79b8cc15db1f81739e81e70587` |
| `dsh-client-ui-renderer/lib/client.js` | `dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356` |
| `dsh-session/lib/index.js` | `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf` |

读法：`tools/probe-host.mjs` 只读解析 asar 头并抽取所需包目录到工作区临时目录（不进入仓库），逐文件计算摘要并与上表比对；不导入 rc.5 源码树到交付物。

## 2. Connection RPC（CTX-RPC-01 的实际字节）

> **实现期更正（CTX-RPC-03，2026-11-07）**：rc.5 的 `ctx.connection.rpc.handle(...)` 对 profile 插件**不可用**。
> 实测在真实隔离 rc.5 Host 中必然抛 `Error: cannot get property "webServer" without inject`：其 `register()`
> 用 connection 服务自身 context 执行 `owner.webServer.register(...)`，而该 context 没有 inject `webServer`；
> 插件自身 ctx、`ctx.inject(['webServer'],...)` 子 ctx、插件 inject 列表声明 webServer 三种方式都失败。
> 实际可用 seam 是 `ctx.connection.fetch.register(route)`（上游 dsh-context 0.82.1 同用此路）：exact
> `POST /api/context-mng/<endpoint>` 路由由共享 `/api` Fetch handler 服务，后者先完成 Host/Origin 围栏与认证，
> 非 owner principal 直接 403，然后才调用路由；exact 路由只收到 `request`，不收到 `peer`。
> 因此本实现以 `fetch.register` 为传输，请求/业务响应/授权语义不变，响应体直接是 BusinessResponse。
> 完整差异、证据与回退见 [CTX-RPC-03 变更单](design-change-ctx-rpc-03.md)。以下为原 RPC 接口的已核字节记录，保留作对照。

来源：rc.5 `dsh-client-connection/lib/index.js`（`lib/types/rpc-host.js` 区段，约 686—970 行）。

- `ctx.connection.rpc.handle(channel, handler)`；`channel` 必须匹配 `^/[A-Za-z0-9._~-]+$` 且不是保留 `/api`。源码看起来把注册绑定到 `owner.effect(...)`，但实测 `owner` 是 connection 服务自身的 context（未 inject `webServer`），调用方真正声明 webServer inject 也无法改变，故该 seam 不可用（见上方 CTX-RPC-03 更正）。
- 端点请求：`POST {channel}/{endpoint}`，`content-type: application/json`，body 为 `{type:"client-request", rpcId, method, payload}`；`endpoint` 段匹配 `[A-Za-z0-9_$.-]+`；`method` 必须等于 URL 的 endpoint。
- 处理器签名：`handler(endpoint, payload, request.signal, peer)`。`peer` 由 Host 认证/信任门禁（`admit`）产生；浏览器共享一个 `{principal:{kind:"owner"}}` Peer。
- 处理器返回值**必须是 RpcResult**：`{ok:true, value}` 或 `{ok:false, error:{code,message,details}}`；成功值不强制校验，由调用方校验。
- 处理器抛异常时，Host 默认路径返回 HTTP 500 且响应体包含 `handler failure: ${String(error)}` —— 插件必须 catch 全部异常并返回固定业务失败，禁止把原 Error 交给该路径。
- 客户端：`ctx.connection.rpc.call(channel, endpoint, payload, signal)` 返回 **RpcResult 本身**（不自动 unwrap）；HTTP 非 2xx 会 throw；rpcId 不匹配会 throw。调用方需要 `result.ok` 分支、固定映射 transport 失败、且不自动重放写操作。

本项目实际使用的业务外壳（本插件自定义，非 Host 方法）：

```text
request  = {schema_version:1, operation_id, context_ref, expected_scope_generation, view_epoch, input}
BusinessResponse = {schema_version:1, operation_id, view_epoch, scope_generation, status, data|reason_code}
```

### 2.1 Exact Fetch route 的请求体语义（复审后补核）

来源：rc.5 `dsh-client-connection/lib/index.js` `bridge()` 与 `createSharedFetchHandler()`。

- route 的 `requestBody` 只为 `"buffered"` 时 Host 才把 body 读满并构造带 Buffer body 的 `Request`；**任何其他值**
  都会走 `new Request(url,{body: Readable.toWeb(req),duplex:"half"})` 的 streaming 分支，不预先缓冲。
- buffered 分支的全局上限默认 `maxRequestBodyBytes = 300 MiB`（`DEFAULT_MAX_REQUEST_BODY_BYTES`）；
  未显式验证前不能把 handler 内的事后长度检查当作传输层分配上限（设计 §5.1）。
- 本插件四个 exact route 显式注册 `requestBody: "streaming"`，并在 `src/transport.mjs` 的 `readJsonBody()`
  实现真正的硬上限：`content-length` 超限在读前拒绝；chunked/流式 body 读到
  `LIMITS.maxRequestJsonBytes`（64 KiB）即取消并返回固定 `LIMIT_EXCEEDED`；RPC handler 的事后 JSON 长度检查
  保留为纵深防御。`tests/transport.test.mjs` 覆盖声明长度、chunked 超限、流错误与正常解析。
- 未执行：真实 Chromium 同源 fetch 的 CSP `connect-src` 与完整页面旅程；隔离 Host 的流式超限 HTTP 证据
  记录在 `docs/task4-evidence.md`（若本次未重跑则明确标注）。

## 3. Session（只读观察接缝）

来源：rc.5 `dsh-session/lib/index.js`、`dsh-agent-loop/lib/index.js`。

- 服务：`ctx.sessions`（`SessionStore`）：`get(id)`、`list()`、`create/prepare/enter/announce`、`flush(session)`；事件 `session/created`、`session/disposed`、`session/event`、`session/flush`。
- `Session.deriveMessages()` 返回当前 surface 的**新数组**，消息对象深冻结；surface 是派生历史的唯一来源。`Session.surface.contentGeneration` 随 append/replace 增长。
- 事件结构：`{seq, time, type, data, surfaceOp?, sourceEventSeqs?}`；`surfaceOp` 为 `"append"` 或 replace op；`tool/result` 的 surface replacement 只允许改 content 且必须单节点。
- `Session.header`：`{version, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset?}`。**rc.5 没有项目 scope 身份/generation 字段**，也没有 dsh-scope 的“项目 scope 服务”（`dsh-scope` 是注册作用域原语，不是项目身份）。因此 07 的 `ScopeRef` 由本插件的 `ContextAccessRegistryV1` 定义，绑定登记即授权来源；运行时核验是“registry binding + 真实 live session id 一致 + generation 未变”，不能从 cwd/正文/前端参数推断授权。
- `agent/pre-step` waterfall：`(payload, next)`，`payload = {messages, turn?, step?, signal}`；`next()` 返回 `{kind:"enter", messages}`；监听者必须原样返回 `next()` 或带决定的 `{kind:"enter"|"reject", ...}`，不得修改 prompt。

## 4. LLM 流（请求观测接缝）

来源：rc.5 `dsh-llm/lib/index.js`（`streamWithRegistration` / `LlmRuntime`）。

- 拦截点：`ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`。监听者签名 `(options, next)`，`next()` 返回 `AsyncIterable<StreamChunk>`；必须恰好调用一次 `next`，原 chunk 对象逐项原样 yield。
- `StreamChunk`：
  - `{type:"block-start", index, blockType}`
  - `{type:"text-delta", index, text}`
  - `{type:"reasoning-delta", index, text}`
  - `{type:"tool-call-delta", index, id, name?, argumentsDelta}`
  - `{type:"block-end", index, block}`
  - `{type:"usage", usage: TokenUsage}`
  - `{type:"finish", reason, replayState?}`
- `TokenUsage = {inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`。
- `options` 由 AgentLoop 在请求边界构造，包含 `sessionId`、`messages`、`tools`、`signal`（本插件只读复制，不修改 options/dispatch）。
- 多个 middleware 的顺序可能改变下游 options/请求；因此本插件该层永远标 `capture_stage:"llm_waterfall"`、`fidelity:"request_observed"`、`wire_verified:false`，绝不称 provider 最终 wire 全文。

## 5. 消息与内容块（分类输入）

来源：rc.5 `dsh-llm/lib/types/message.js`、`lib/typert.host.js` 类型声明。

- `Message = {id, role, content, source, toolCallId?, isError?}`；`role ∈ {system, developer, user, assistant, tool}`。
- `source.kind` 实际值包括：`system-prompt`、`model`、`tool`、`user`、`skill-invocation`、`agent-message`、`team-message`、`subagent-settled` 等；`tool` source 带 `callId`。
- `ContentBlock`: `{type:"text",text}`、`{type:"reasoning",text}`、`{type:"tool-call",id,name,arguments}`、`{type:"image",attachment,offloaded?}`；工具结果消息的 content 为文本/内容块数组，`isError` 表失败。
- 05 注入/召回来源标记目前**没有统一标准名**；本插件只承认显式登记在分类规则中的可信来源标记（如 `memory-injection`/`memory-recall` 等白名单前缀），其余按 role/结构作 `heuristic`，无法确定即 `unknown`。禁止从正文出现 “memory/system/secret” 等词推断来源或权限。

## 6. Client 插件与 UI 接缝

来源：rc.5 `dsh-client-modules/lib/index.js`、`lib/client.js`、`dsh-client-ui-layout/lib/client.js`、`dsh-client-ui-renderer/lib/client.js`、`dsh-agent-preset/skills/cordis-plugin-development`。

- Client 产物格式：`window.__ModuleLoader__.load({ id: "<package-name>", factory(require) { ... return { name?, inject: [...], apply(ctx) {...} } } })`。浏览器模块表提供 `react`、`react/jsx-runtime`、`react-dom`；其余运行时导入需在 `dsh.client.external` 声明。`inject` 里的 client 包按顺序先加载。
- `package.json` 需 `dsh.client = {platform:"web", immediately?:true, inject:[...]}`，导出一个 `./client` 子路径；Host 端 `dsh-client-modules` 会按声明组装 combo script 并注入 `window.__DSH_BOOT__`。
- Slots：`ctx.slots.inject(slotName, () => ctx.slots.register(options, Component))`；main 面板注册 `{name:"main", key:"local-context", locale}`，然后 `ctx.layout.selectPanel("local-context")`；关闭面板 `ctx.layout.selectPanel(null)`。`ctx.slots.entries("main")` 的 `options.key` 是 panel id。
- Layout service：`ctx.layout.selectPanel(panelId|null)`；main 渲染 `renderSlot("main", {}, {entryKey: usePanelInfo(info => info.activePanelId) ?? "conversation"})`。
- Connection client service：`ctx.connection.rpc.call(channel, endpoint, payload, signal)`（`rpc.call` 返回 RpcResult，见 §2）。
  **实现更正（CTX-RPC-03）**：本插件不使用该路径（Host 侧 `rpc.handle` 在 rc.5 不可用）。浏览器侧直接
  `fetch('/api/context-mng/<endpoint>', {method:'POST', headers:{'content-type':'application/json'}, body, signal})`；
  同源 cookie 由浏览器自动携带，Host 共享 `/api` handler 先做认证/owner 门禁，响应体直接是 BusinessResponse。
  client 不使用 `ctx.connection.rpc.*`，也不从 `window` 之外的任何位置读取调用者身份。
- Sessions client service：`ctx.sessions.retain(id, {source})`、`ctx.sessions.list.getSnapshot().byId`；ui-workspace 用 `Object.values(...byId).find(row => (row.retainedBy.mainView ?? 0) > 0)` 取当前主会话。本插件用同一只读选择器确定“当前会话”，只用于选择已登记绑定，不构成授权。
- Locale：面板可见文本走 client locale service；本插件提供 `locale/en.json`、`locale/zh.json`（`meta.title/description` 供插件管理页展示）。

## 7. 工程与运行环境限制（本轮实现记录）

- 实现期把 rc.5 只读抽取物与临时产物放在工作区/临时目录，不进仓库；不修改 `~/.dsh` 现有 desktop/web profile。
- 隔离宿主验证用 rc.5 CLI（从 app.asar 只读抽取后以临时 `DSH_HOME` 运行）：真实 Web/loader/RPC、完整 Headless AgentLoop、真实 Chromium 页面与真实已注册 Provider 测试均已执行，证据见 `docs/acceptance-gates.md` 与 `evidence/task5-*`。OS/Electron 级包捕获出口认证因当前会话未提权被平台阻断，真实面板绑定数据读数仍未执行，均保留未认证。
- 本机工作区子目录对沙箱化 shell 的写入受 Windows ACL/完整性级别限制；测试临时文件写到系统临时目录，交付文件由文件工具写入。该限制不属于插件行为，也不得写成产品限制。
