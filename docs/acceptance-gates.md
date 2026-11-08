# 07 验收门禁补齐记录（G0–G5 对照）

版本：CTX-GATES-1；日期：2026-11-08；状态：**除 OS/Electron 级出口认证外，设计所列首版门禁均已实际执行**。本文记录命令、层级、结果与未执行项；低层证据不冒充高层。

## 0. 本轮补跑环境

| 项 | 值 |
|---|---|
| 已安装 Harness | 0.2.1-rc.5（app.asar SHA256 `e1b6f25f…c6915`，与设计 pin 一致） |
| 测试运行时 | Node **v24.18.1**（`C:\Users\admin\.dsh\electron\electron.exe` + `ELECTRON_RUN_AS_NODE=1`，Electron 43.3.0）与 Node v26.13.0 双跑 |
| 隔离 Host | 从 app.asar 只读抽取的 rc.5 运行时 + 临时 `DSH_HOME`（Web/Headless profile），未修改用户 desktop/web profile |
| 真实 Provider | 在 `C:\Users\admin\.dsh`（原凭据库，**未复制/未输出任何密钥**）新建一次性测试 profile `07real`，经真实 web API 发 2 次极小合成请求（限 3 次内） |
| 浏览器 | Google Chrome 156.0.8078.80，headless + DevTools Protocol（页面级真实渲染，不是 jsdom） |

## 1. G0 来源与范围 ✔

- `source-lock.json`：Host 0.2.1-rc.5 安装字节摘要、dsh-context 固定树（仅机制借鉴、无源码）、无运行时依赖。
- 设计 pin 的 5 个 rc.5 文件 SHA256 均与 app.asar 实际字节一致（`tools/probe-host.mjs` 每次重核）。
- 范围：只读首版；维护 T5 后置且 `maintenance.enabled=true` 在配置层被拒绝。

## 2. G1 本地行为 ✔

- 组件/合同测试：**178 / 178 pass**（Node 26.13.0，`evidence/task4-full-suite.tap`）。
- **Node 24 复跑**：Node 24.18.1 / Electron 43.3.0，12 个测试文件 **178 / 178 pass**，0 fail 0 skip（`evidence/task5-node24.tap`）。
- 真实安装字节探针：28/28（真实 `dsh-session` derive/真实 cordis `llm/stream` dispatch/真实 SessionStore + capture；`evidence/task2-probe.json`）。
- fixture smoke：9/9、出站 0（`evidence/task3-smoke.txt`）。

## 3. G2 隔离集成 ✔（含完整 AgentLoop 与真实浏览器）

### 3.1 完整 rc.5 Headless Host + 真实 AgentLoop（fake adapter，无网络/无凭据）

- 隔离 `DSH_HOME` + shipped `headless` profile + `probe-fake-llm` bundle（真实 `LlmAdapter` 注册 provider `probe-fake`）+ 本插件 bundle。
- 执行真实 `dsh headless --json` 三回合；第 3 回合（`--session-id` 复用已存在合成 session）结果：
  - stdout：`turn_start → step_start → text "OK" → step_end usage {inputTokens:37, outputTokens:2, totalTokens:39, cacheReadTokens:5} → turn_end → final "OK"`（`evidence/task5-agentloop.out`）。
  - 真实 `agent/pre-step` 命中：`{"stage":"agent_pre_step_probe","messages":1,"hasTurn":true,"hasStep":true}`。
  - 插件捕获 `llm_waterfall`：`input_tokens=37, output_tokens=2, cached_input_tokens=5, is_final=true`，`wire_verified=false`，7 groups；随后 `session_surface` revision 2、7 groups（`evidence/task5-agentloop-observations.jsonl`）。
- 证明：完整 Loader→base profile→AgentLoop→真实 Session→真实 `agent/pre-step`→真实 `llm/stream` waterfall→本插件捕获链路成立；模型为脚本化替身，**不是**真实 Provider。

### 3.2 真实 Chromium 页面（隔离 Web Host + 插件）

- 启动真实 `dsh web`（隔离 `DSH_HOME`），headless Chrome 通过 token URL 取得真实 cookie，加载真实 GUI。
- 13 项检查全部通过（`evidence/task5-chromium.json`、截图 `evidence/task5-panel.png`）：
  - app shell 渲染；`window.__DSH_BOOT__` 含 `dsh-context-mng`（client bundle 真实入图）；
  - 侧栏入口「上下文」可点击，`.dsh-context-panel` 渲染，显示当前 session id、阶段按钮、明确 unbound 文案；
  - 页面内同源 `fetch('/api/context-mng/context.list')` → 200 固定 BusinessResponse；
  - 关闭按钮恢复 `selectPanel(null)`；
  - 网络请求全部同源、无失败、无 CSP 违规、无外部请求。
- **浏览器级负向出口**：同一旅程在 Chrome `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`（阻止一切外部 DNS）下 **13/13 仍通过**（`evidence/task5-chromium-blocked.json`），证明页面/插件无外部网络依赖。

### 3.3 安装 / 卸载（宿主支持路径）

- 隔离 profile 上执行 `dsh plugin --profile 07inst add file:E:/dsh/plugin/07-context-management --offline` → exit 0；profile `dependencies` 与 `dsh.profile.bundles` 自动加入插件；真实 web Host 启动后 `/api/context-mng/context.list` 返回 200 ok。
- `dsh plugin --profile 07inst remove dsh-context-mng --offline` → exit 0；profile 依赖与 bundle 均移除；重启 Host 后同端点 **404**（卸载后无残留路由）。
- 方法：`DshHome/profiles/07inst` 一次性 profile；未修改用户现有 profile。

## 4. G3 独立评审 ✔

- `docs/implementation-review.md`：无 Critical；2 Important（请求体传输层上限、导出幂等）+ 3 Minor，均已修复并回归。
- 修复后组件回归 178/178，并在真实隔离 Host 上复验流式 body 超限 `LIMIT_EXCEEDED`（`evidence/task4-host-rpc.txt`）。

## 5. G4 授权安装 / 已注册 Provider 真实测试 ✔（隔离测试 profile，凭据留在原库）

- 在真实 `DSH_HOME` 下新建一次性 profile `07real`（web template + 本插件 + registry 绑定合成 session），**不读取/不复制凭据**，由宿主凭据服务使用原有 `DEEPSEEK_API_KEY`。
- 通过真实 web API：`session/create`（指定合成 sessionId）→ `session/prompt`（一次极小提示 `Reply with exactly OK`）→ 轮询本插件 `/api/context-mng/observation.get`。
- 结果（第 2 次运行，`evidence/task5-real-provider.json`）：
  - `route_revision = route:deepseek-official/deepseek-flash`（真实已注册 Provider/模型）；
  - provider 实报 usage：`input_tokens=437, output_tokens=2, cached_input_tokens=8704, source=provider_usage_chunk, is_final=true`；
  - 插件估算（UTF-8 字节）`tokens=36742`，6 groups，`wire_verified=false`；估算与实报并列、不互相分摊；
  - Host stderr 记录真实模型目录请求 `https://api.deepseek.com/models`（批准模型 API 目标）。
- 请求次数：共 2 次真实模型请求（首轮 9141 input/2 output/0 cached，次轮 437/2/8704），均 ≤ 设计限 3 次、输入极小、输出 2 tokens；无凭据进入日志/证据。
- **未做**：把插件安装进用户正在运行的 desktop/web profile；本轮使用一次性测试 profile（`07real`），测试后删除。

## 6. G5 工作台（08）集成 — 不适用/未执行

08 能力尚未交付；07 独立验收成立，不把 08 未实现计为 07 失败。

## 7. 未补齐/被平台阻断的门禁

| 项 | 状态 | 具体原因与替代证据 |
|---|---|---|
| OS/Electron 级出口认证（pcap/防火墙级） | **BLOCKED** | 当前进程非管理员（`adminRole=False`）；`pktmon start --capture` 返回 access denied（无法与 PktMon 驱动通信），`netsh trace start capture=yes` 要求提权；审批提示已禁用，无法请求提权或修改防火墙。替代（非等价）：Node API guard 出站 0、真实 Chrome CDP 全请求同源、外部 DNS 全阻断仍通过、真实 Provider Host 仅访问登记 `api.deepseek.com`、静态扫描无 fetch/http/子进程。**不得声称 OS 级无外发已认证。** |
| 绑定数据在真实 Chromium 面板中的读数一致性 | 未执行 | 面板真实渲染/unbound/同源 RPC/CSP 已验证；但把“已捕获 observation（含 provider usage）渲染进真实面板并与 RPC 数值逐项对比”未执行。组件测试覆盖相同渲染逻辑，层级不同。 |
| 维护（T5） | 按设计后置 | `maintenance.enabled=false` 强制；无 Host 共享运行租约/flush 证据，不开放写路径。 |
| 用户现有 profile 安装 | 未执行 | 现有授权允许安装/API 测试，但本轮为不影响用户运行环境，选择一次性测试 profile；用户现有 desktop/web profile 未被修改。 |

## 8. 证据索引

| 证据 | 内容 |
|---|---|
| `evidence/task5-node24.tap` | Node 24.18.1 下 12 文件 178/178 TAP |
| `evidence/task5-agentloop.out` | 完整 Headless Host 真实 AgentLoop 回合 stdout（usage 37/2/39/5） |
| `evidence/task5-agentloop-observations.jsonl` | 真实 agent/pre-step 命中 + 插件 llm_waterfall/session_surface 捕获 |
| `evidence/task5-chromium.json` / `task5-chromium-blocked.json` | 真实 Chrome 页面 13 项检查（普通 / 外部 DNS 阻断） |
| `evidence/task5-panel.png` | 真实页面面板截图 |
| `evidence/task5-real-provider.json` | 真实 Provider 回合：route、usage、estimate、groups、timings |
| `evidence/task5-install-uninstall.txt` | `dsh plugin add/remove` 命令与实际结果 |
| `evidence/task5-os-egress-blocked.txt` | pktmon/netsh 拒绝与替代证据说明 |

**结论：** G0/G1/G2/G3/G4 已按上述层级实际执行；OS/Electron 级出口认证因缺少管理员/包捕获能力被平台阻断，真实面板绑定数据读数一致性仍未执行——这两项保留为未认证，不能以其他层证据替代。
