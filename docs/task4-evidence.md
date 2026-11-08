# 07 T4/T6 证据：隔离 Host、出口、全量回归与交付

版本：CTX-EVID-5；日期：2026-11-07；状态：只读首版完成，已过独立复审并修复 Important 项。证据按设计 §9“运行记录 v1”字段记录；证据层级分开，低层通过不冒充高层运行。

## 1. 固定身份与运行环境

| 项 | 值 |
|---|---|
| 已安装 Harness | 0.2.1-rc.5（`E:\dsh\resources\app.asar\dsh\package.json`） |
| app.asar SHA256 | `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915`（182,766,714 B） |
| Electron | 44.7.0 |
| 实现/测试 Node | v26.13.0（设计基线 Node >=24.9；本机无 Node 24，**未在 Node 24 运行**） |
| source-lock 摘要 | `source-lock.json`（含 pinned package SHA256 清单） |
| 隔离 DSH_HOME | 首轮：工作区 `.work07/.sandbox/dsh-home`；复审重跑：`%TEMP%\ctxmng-host-extract\dsh-home`。均为一次性目录，非用户 profile |
| rc.5 运行时抽取 | 从 app.asar 只读解析到临时目录（含 `<asar>.unpacked` 回退）；抽取物不进入仓库 |
| 凭据/真实会话 | 未读取、未使用；隔离 Host 使用临时 launch token，证据中 token/cookie 均已脱敏 |

## 2. 运行记录

| # | 命令 | 层级 | exit | pass/fail/skip | 证据 |
|---|---|---|---|---|---|
| 1 | `node --test --test-isolation=none tests/` | 组件/合同 | 0 | **178 / 0 / 0** | `evidence/task4-full-suite.tap` |
| 2 | `node tools/probe-host.mjs --asar "E:/dsh/resources/app.asar"` | 实际安装库（rc.5 字节） | 0 | 28 / 0 / 0 | `evidence/task2-probe.json`、`docs/task2-evidence.md` |
| 3 | `node tools/context-report.mjs --fixture` | 组件（合成双会话） | 0 | 通过（schema 校验） | `evidence/task3-cli-report.txt`、`docs/task3-evidence.md` |
| 4 | `node tools/observe-smoke.mjs --fixture --network-evidence` | 组件 smoke + Node 级出口断言 | 0 | 9 / 0 / 0；outbound attempts=0 | `evidence/task3-smoke.txt`、`docs/task3-evidence.md` |
| 5 | 隔离 rc.5 `dsh` CLI：`--dump-config` 组合 + `dsh web --host 127.0.0.1 --port 0 --no-open` + 真实 cookie 认证 + 四端点 POST（复审后重跑，含超限 body） | 隔离完整 Host（真实 Loader/Web/HTTP/Connection/bridge） | 0 | 见 §3（全部符合预期） | `evidence/task4-host-rpc.txt` |
| 6 | `node --test --test-isolation=none tests/transport.test.mjs`（流式 body 上限专项） | 组件/合同 | 0 | 11 / 0 / 0 | `evidence/task4-transport.tap` |
| 7 | `node --test --test-isolation=none tests/service.test.mjs`（导出幂等专项） | 组件/合同 | 0 | 14 / 0 / 0 | `evidence/task4-service.tap` |

注：`node --test`（默认进程隔离）在本机 DSH Windows 沙箱内因子进程管道被禁（`spawn EPERM`）失败；这是本机沙箱限制，不是插件行为。使用 `--test-isolation=none` 得到等价测试执行，已记录在 task1/task2 证据中。

## 3. 隔离 rc.5 Host 实测（真实 Web + 真实认证）

方法：用 app.asar 抽取的 rc.5 CLI，以临时 `DSH_HOME` 从 shipped web 模板创建隔离 profile；插件目录以 profile bundle 方式装载；`--dump-config` 确认组合行 `context-mng` 存在；再 `dsh web --port 0 --no-open` 启动，读取打印的 launch URL，用 GET `/?token=...` 换取浏览器 cookie，然后以同源 POST 调端点。日志与响应保存在 `evidence/task4-host-rpc.txt`。

| 请求 | HTTP | 响应（脱敏后） | 含义 |
|---|---|---|---|
| `POST /api/context-mng/context.list`（已登记 ctx-a） | 200 | `{"status":"ok","data":{"contexts":[{"context_ref":"ctx-a","session_ref":"session-none","scope_id":"project-a","generation":3,"read":true,"export_root_refs":[]}]}}` | 真实路由+认证+registry 摘要；无路径/正文 |
| `POST /api/context-mng/observation.get`（ctx-a/已登记但无 live session） | 200 | `{"status":"unavailable","reason_code":"SESSION_UNAVAILABLE"}` | 访问登记通过后正确识别 session 不可用 |
| `POST /api/context-mng/observation.get`（请求体伪造 `caller`） | 200 | `{"status":"invalid","reason_code":"INVALID_REQUEST"}` | 严格 schema 拒绝伪造字段 |
| `POST /api/context-mng/maintenance.apply` | 404 | `not found` | 未登记 endpoint 由 Host 路由层拒绝 |
| `POST /api/context-mng/group.read`（未知 observation） | 200 | `{"status":"stale","reason_code":"STALE_OBSERVATION"}` | 不接受与观察不匹配的正文读 |
| `POST /api/context-mng/report.export`（未登记 output_ref） | 200 | `{"status":"denied","reason_code":"OUTPUT_REF_DENIED"}` | 导出根限制生效 |
| 无 cookie 的 `POST /api/context-mng/context.list` | 401 | `unauthorized` | Host 在插件之前做认证/fence |
| `context.list` + **声明 Content-Length ≈ 70 KB** | 200 | `{"status":"invalid","reason_code":"LIMIT_EXCEEDED"}` | 复审 Important-1 修复：Host 走 streaming 分支不缓冲，插件在读前按 content-length 拒绝 |
| `context.list` + **chunked ≈ 70 KB**（无 content-length） | 200 | `{"status":"invalid","reason_code":"LIMIT_EXCEEDED"}` | 复审 Important-1 修复：插件按 64 KiB 硬上限截断并取消流 |

**传输 seam 实测更正**：同一隔离 Host 上，`ctx.connection.rpc.handle(...)` 对 profile 插件必抛
`Error: cannot get property "webServer" without inject`（插件 ctx、`ctx.inject(['webServer'])` 子 ctx、插件 inject 声明 webServer 三种方式均失败）；
`ctx.connection.fetch.register(...)` 正常。因此按 [CTX-RPC-03](design-change-ctx-rpc-03.md) 使用 exact Fetch routes，
业务响应/授权语义保持设计不变。该失败与成功均有隔离 Host 运行记录；未把源码阅读当运行证据。

### 3.1 独立复审后的修复验证

独立复审（`docs/implementation-review.md`）未发现 Critical；2 个 Important 已修复并回归：

1. **请求体上限**：exact route 改注册 `requestBody:"streaming"`（rc.5 bridge 只有 `"buffered"` 才预缓冲），`src/transport.mjs` 新增 `readJsonBody()`：content-length 超限读前拒绝，chunked body 读到 64 KiB 即取消。组件测试 + 上表两条真实 Host 超限请求均通过。
2. **导出幂等**：`report.export` 的 `exported_at` 改为取 observation 的 `captured_at`（同一 observation/revision 不可变），使重复导出字节完全一致并命中 writer 的 saved 幂等；`tests/service.test.mjs` 以真实 writer + 两个不同墙钟实例验证同一文件、同 digest、无 conflict。

复审 3 个 Minor 也已修复：client 会话 hook 变 null 时清空旧会话数据/轮询、`group.read` 响应校验 scope_generation、CTX-RPC-02 变更单状态文本更新；同时把 client 模块 inject 收窄为实际使用的 `['slots','layout','locale']`（`useSessions` 来自 slots 框架 standardProps，静态核对 rc.5 `dsh-cordis-client-runner` client 的 `standardProps` 声明）。

## 4. 没有执行的层级（如实列为未验证）

- **真实 Chromium 页面旅程**：未在现有 Harness Web UI 加载 client bundle，未验证 main slot 渲染、真实同源 fetch/CSP `connect-src`、locale 切换、键盘焦点、暂停/切会话/关闭的用户旅程。client 仅通过 Node 合同测试（fake-React/fake-ctx）。`useSessions` 作为 standardProps 的契约已从安装字节静态核对，但未在页面运行。
- **隔离 Host 中的成功观察路径**：未在隔离 host 创建真实 live session（不接模型/不导入用户会话），因此 `observation.get` 的 ok 采样路径在完整 Host 上未执行；该路径由实际安装库探针（真实 SessionStore + capture）与组件测试覆盖，但层级不同。
- **真实模型/Provider/网络**：未调用任何模型 API，未验证 wire usage 的真实 provider 差异；`wire_verified` 固定 false。
- **OS/Chromium 级出口认证**：`--network-evidence` 仅为 Node API guard 级别；未对 Electron/Chromium/子进程做系统级旁路审计。
- **Node 24 运行**：未执行（本机只有 Node 26.13.0）。
- **symlink 真实创建**：Windows 本机无创建符号链接权限，相关拒绝分支通过注入 fs 适配器验证（task3 证据说明）。
- **维护（T5）**：按设计后置且 `maintenance.enabled` 强制 false，未实现、未验证。

## 5. 数据安全与恢复

- 没有读取、复制或输出用户凭据/真实会话；隔离 host 的 launch token 与 cookie 在落盘证据前已脱敏。
- 隔离 profile 与 rc.5 抽取物均在临时目录且不提交；删除临时目录即可恢复（不影响用户 `~/.dsh`，本轮未修改用户 profile）。
- 当前运行的 Harness 未被安装/修改；未启动替代 GUI 服务。
- 失败恢复：隔离 host 为一次性进程（脚本结束强制停止）；未产生持久会话或报告文件。

## 6. 结论

只读首版在**组件/合同层**与**实际安装库层**通过，并在**隔离完整 rc.5 Host 的加载/认证/路由/拒绝路径（含流式 body 上限）**上通过；独立复审的 Critical/Important 项均有修复与回归。真实 Chromium 用户旅程与真实 Provider 请求未执行，不得声称完整产品验收。维护按设计保持后置。
## 7. 后续验收门禁补齐（2026-11-08）

Node 24、完整 Headless AgentLoop/agent-pre-step、真实 Chromium 页面（含外部 DNS 阻断）、真实已注册 Provider、
宿主安装/卸载已在后续轮次实际执行，证据与未执行项见 [验收门禁补齐记录](acceptance-gates.md) 与 `evidence/task5-*`。
OS/Electron 级包捕获出口认证因当前会话未提权被平台阻断；真实面板绑定数据读数未执行。