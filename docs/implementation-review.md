# 07 实现独立复审记录（T6 复审）

版本：CTX-REVIEW-1；日期：2026-11-07；复审角色：独立子代理（未参与 07 设计/实现/文档编写）；复审对象：提交 `1eded40` 及其后两份证据/计划小改（`a8288ed`、`db6e7d9`）时的仓库字节；复审方式：只读源码/文档/测试，可运行只读测试命令（`node --test --test-isolation=none tests/`、fixture CLI），未安装插件、未修改任何文件、未读取用户凭据/真实会话、未调用模型。

**结论：VERDICT = CHANGES-REQUIRED（无 Critical；2 Important）。** Important 与 Minor 已在复审后由实现方修复，并重新运行组件测试与隔离 rc.5 Host 证据（见 §3、§4）。本记录保留原发现与处理结果，后续改动不得沿用本记录认证新字节。

## 1. 独立复核的事实

- 复审自行复跑 `node --test --test-isolation=none tests/`：**175 pass / 0 fail / 0 skip**（修复前快照）。
- 复审自行从 app.asar 核对设计引用的 rc.5 SHA256：`dsh-client-connection/lib/index.js` `0ebcca…`、`client.browser.js` `dfc354…`、`dsh-client-ui-layout/lib/client.js` `eb011a…`、`dsh-session/lib/index.js` `2f5dd0…`，全部与实际安装字节一致。
- 复审确认 owner 门禁假设在安装字节中真实存在：rc.5 `createSharedFetchHandler` 在调用 exact route 前对非 owner principal 返回 403，且 exact route 拿不到 peer 对象（与本实现 `src/transport.mjs` 的 owner-gate caller 记录一致）。

## 2. 复审发现与处理

### Critical

无。复审逐项核对后确认安全边界是代码事实而非文档声明：

- caller 只来自 Host peer（`src/rpc.mjs` callerFromPeer），JSON 中的 caller/principal/grant 被严格 schema 拒绝；
- 访问先于正文：`src/access.mjs` 授权、`src/capture.mjs` 在 `readSurface/deriveMessages` 前复核 binding；
- 导出目标 leaf-only、root realpath 限定、符号链接目标拒绝、临时文件→fsync→rename；
- 维护写路径不可通过配置开启（`normalizeConfig` 拒绝 `maintenance.enabled=true`）；
- 观察路径无 `child_process`/`http`/`fetch`（源码扫描），无网络。

### Important（均已修复）

| ID | 发现 | 处理 | 复验 |
|---|---|---|---|
| REV-01 | 请求体大小上限只在 `request.json()` 完整缓冲/解析后才检查；rc.5 exact route 默认 buffered 分支可缓冲至 300 MiB。设计 §5.1 明确要求验证全局 body 上限、事后检查不能充当传输层分配证明 | `src/transport.mjs` 四个 exact route 改注册 `requestBody:"streaming"`（rc.5 bridge 只有 `"buffered"` 才预缓冲，其余走流式 Request）；新增 `readJsonBody()`：content-length 超限读前拒绝，chunked body 读到 64 KiB 即取消；rpc 事后检查保留为纵深防御 | `tests/transport.test.mjs` 11/11；隔离 rc.5 Host 实测声明长度与 chunked 两种 ≈70 KB 请求均返回固定 `LIMIT_EXCEEDED`（`evidence/task4-host-rpc.txt`） |
| REV-02 | 服务层导出的 `exported_at` 每次取墙钟，使同一 observation/revision 重试产生不同字节，writer 返回 conflict，设计 §4“相同 report_id 相同内容重复返回已保存”不可达；writer 级测试用固定 fixture 覆盖不到 | `src/service.mjs` 报告 `exported_at` 改为取 observation 的 `captured_at`（同一 observation 不可变）；report_id 仍含 revision，不同 revision 永不覆盖 | `tests/service.test.mjs` 新增真实 writer 集成用例：两个不同墙钟下重复导出同一 revision → 均 saved、同 report_ref/digest、仅一个文件；14/14 通过 |

### Minor（均已修复）

1. `ui/context-panel.js`：当前会话 hook 变为 null 时未清空旧会话数据/轮询 → 现在始终调用 `store.selectSession(current ?? null)`，store 走 unbound 清空路径。
2. `ui/context-store.js`：`group.read` 未校验响应 `scope_generation` → 已补校验，不匹配置 `stale/STALE_SCOPE`。
3. `docs/design-change-ctx-rpc-02.md` 状态文本仍称“隔离宿主 RPC 待验”，被 CTX-RPC-03 实测覆盖 → 已更新。

### 复审指出的实现风险（非缺陷，已在静态层面对齐）

- 复审无法确认真实页面是否向 main keyed panel 提供 `props.useSessions`。实现方补充静态核对：rc.5 `dsh-cordis-client-runner` client bundle 的 `standardProps` 声明确有 `useSessions: UseSessions`，与上游 dsh-context 使用同一 `props.useSessions` 约定；因此保留该实现，但**页面层仍未运行验证**。
- 复审质疑 client service `sessions` 是否真的提供。实现方将 client 模块 `inject` 收窄为实际使用的 `['slots','layout','locale']`（`useSessions` 来自 standardProps，不需要该 service），消除 apply 被服务等待阻塞的风险；`dsh.client.inject` 的包级加载顺序保持不变。
- `connection` 已不在 client 模块 inject 中（数据路径为同源 fetch），仅保留在 package.json 的 `dsh.client.inject` 顺序声明中。

## 3. 修复后的回归证据

- `node --test --test-isolation=none tests/`：**178 pass / 0 fail / 0 skip**（`evidence/task4-full-suite.tap`）。
- 专项：`tests/transport.test.mjs` 11/11（`evidence/task4-transport.tap`）；`tests/service.test.mjs` 14/14（`evidence/task4-service.tap`）。
- 隔离 rc.5 完整 Host 重跑（真实 Loader/Web/HTTP/connection bridge/owner cookie）：路由、registry、伪造字段、未知 endpoint、未认证、未登记导出根均保持固定拒绝；新增两条流式超限 body 均 `LIMIT_EXCEEDED`（`evidence/task4-host-rpc.txt`）。
- 复审前的 175-test 证据与修复后的 178-test 证据都保留在 `evidence/`；不得用修复后字节认证复审前的行为。

## 4. 复审与实现共同声明的未验证层

- 真实 Chromium 页面旅程、CSP `connect-src`、slot 渲染、locale/键盘、切会话/暂停/关闭的用户旅程未执行。
- 完整 Host 上的 `observation.get` ok 采样路径（无真实 live session/模型）未执行，由安装字节探针与组件测试分层覆盖。
- 真实 Provider 的 usage chunk 语义、真实模型请求未执行；`wire_verified=false`。
- OS/Electron 级出口认证未执行（只有 Node API guard 级网络证据）。
- Node 24 未运行（本机 Node 26.13.0）；Windows 真实符号链接拒绝分支未用真实 symlink 验证（注入 fs）。
- 维护（T5）按设计后置、`maintenance.enabled=false`，未实现。

## 5. 复审结论与后续

复审认为：无 Critical 安全/设计违背；2 个 Important 属可编码性/设计准则问题而非越权，修复后组件测试与隔离 Host 回归通过。后续若改动 transport/service/access/schema 或维护写路径，须重新复审受影响合同，不得沿用本记录认证新提交。真实 Chromium/Provider 验收仍是未执行门禁。
