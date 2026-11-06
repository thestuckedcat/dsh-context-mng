# 07 上下文观察：机制说明（完成交付）

版本：CTX-MECH-1；日期：2026-11-07；状态：只读首版已实现并自测。本文按[机制说明合同](../../docs/mechanism-document-contract.md)解释实际行为、判断规则、证据与失败恢复，供后续 skill 改进引用。维护（T5）按设计后置，未实现。

## 1. 能力与分层

| 层 | 负责 | 不负责 |
|---|---|---|
| skill（后续可加） | 何时打开/暂停/展开/导出、如何向用户解释估算与实报差异、如何引导登记绑定、复用报告的后续阅读流程 | 绕过 scope/秘密/尺寸/一次提交等硬边界；不能把未验证结果说成事实 |
| Host plugin（`index.js` + `src/*.mjs`） | 采样授权会话、分类/脱敏/估算、有界缓存、四个只读业务端点、报告原子导出、生命周期与取消 | 修改 prompt/历史/stream；网络；子进程；凭据；跨会话搜索 |
| client plugin（`client.js` + `ui/*`） | 当前主会话→已登记绑定的只读映射、面板渲染、轮询/暂停/切会话取消、分页取正文、用户触发的导出 | 读磁盘、读其他插件 DOM、自授 scope、展示原始错误文本 |
| Host/OS | 真实 Session/LLM seam、浏览器 cookie 认证与 owner 门禁、cordis 生命周期、文件系统权限 | — |

Host 是唯一掌握会话数据与真实 owner 身份的一方；client 只做展示与用户动作；观察路径没有模型调用、网络和子进程。

## 2. 端到端机制图（典型旅程 + 分支）

```text
用户打开“上下文”面板
  → client 读取当前主会话（ctx.sessions.list: retainedBy.mainView>0）
  → POST /api/context-mng/context.list（Host: cookie 认证/fence → owner 门禁 → 插件路由）
  → registry 返回已登记 active 绑定摘要（无路径/正文）
  → 选中 session_ref 匹配的 context_ref；无 → unbound 空态
  → POST observation.get(stage=session_surface)
  → access.checkContext（owner + context_ref + generation）→ 失败 denied/stale
  → 缓存命中：返回 revision/changed；未命中且 stage=session_surface → 采样
  → host.readBoundary → deriveMessages → readBoundary；变化重采一次，再变 → stale
  → classify → redact → estimate → projection → store.put（有界、revision、去重）
  → 面板渲染来源组成/占比/估算（UTF-8 字节）/provider 实报/阶段/精度标签
  → 500ms 轮询（visible && panel active && !paused；同 view 最多 1 个在途）
  → 展开组：POST group.read → 重读 live surface 并核对 boundary → 分页返回脱敏正文
  → 导出：POST report.export（用户触发一次）→ registry 根 + revision 校验 → 临时文件+fsync+rename
  → 关闭/切会话/撤权/卸载：abort + epoch++ + 清正文；Host 侧释放监听/缓存
```

异常分支：无请求观测 → `changed:false` 空态（不造假数）；session 不可用 → `unavailable/SESSION_UNAVAILABLE`；
surface 变化 → `stale/STALE_OBSERVATION`（客户端刷新）；取消/断线 → 固定 `TRANSPORT_FAILURE`，不自动重发；
导出冲突 → `status:"conflict"` 不覆盖；导出路径/符号链接越界 → 拒绝且不写。

## 3. 决策规则（稳定机制编号）

### CTX-OBS-01 授权后的只读 surface 采样

- 触发：`observation.get(session_surface)` 无缓存；或 `session/event` 合并窗口到期；或 session 创建。
- 前置：registry binding 存在且 active/read；caller 为 Host owner 门禁结论；session live。
- 判断：先读 `{session.seq, surface.contentGeneration}`，`deriveMessages()` 后再读；不一致 → 重采一次，再变 → stale。缓存 key 含 `session_ref+stage+request_ref|boundary+observed_digest`。
- 动作/状态：`classify→redact→estimate→projection`，写有界 store，分配每会话单调 revision。
- 失败恢复：采样异常只丢本插件观察并记非秘密错误码；不重试主请求、不缓存半成品；连续 stale 由客户端刷新解决。

### CTX-OBS-02 `llm/stream` 请求观测（透明）

- 触发：`ctx.on('llm/stream', (options,next)=>...)` 且 `options.sessionId` 已登记绑定。
- 判断：仅在访问登记通过后复制 `options.messages/tools` 做投影；`next()` 恰好一次；原 chunk 对象逐个原样 yield，不缓冲整条流。
- 状态：`capture_stage=llm_waterfall, fidelity=request_observed, wire_verified=false`；本地 `request_ref=序号+session+代次`；usage chunk（`inputTokens/outputTokens/cacheReadTokens/...`）映射到 `reported_usage`，`is_final` 仅在 finish 后 true；取消后的迟到 usage 仍属原 request 且 `is_final=false`。
- 失败恢复：观测失败（分类/脱敏/缓存）只丢观察；`next` 抛错原样重抛；不修改 options/messages/prompt。

### CTX-OBS-03 来源分类

- 触发：每条 Message 进入投影。
- 规则优先级（固定）：可信 Host `source.kind` 映射 → 05 显式 memory 标记白名单（`memory-injection`/`memory-recall` 前缀）→ role/结构 heuristic → unknown。工具定义单独归 `tools/identified`；正文出现 “memory/system/secret” 等词**不改变**分类。
- 状态：`category/certainty(identified|heuristic|unknown)/source_kind/source_ref`；未知保持 `unknown` 且不猜。
- 失败恢复：无可信标签时宁 unknown 不误归类；分类规则变更属代码/策略边界，不由 skill 文本改变。

### CTX-OBS-04 秘密过滤（显示与导出出口）

- 触发：任何预览/正文/报告生成前。
- 规则：确定性模式（API key/JWT/Bearer/私钥/password 赋值等）替换为 `[REDACTED:<category>]`；同内容幂等；不过度吞普通文本；不记录原文。
- 状态：`redaction_count` 与类别计数进入组/观察；`observed_digest` 仅对脱敏后内容计算（同内容不同秘密 → 同 digest）。
- 失败恢复：过滤异常按失败关闭（不展示未过滤文本）；导出前再次扫描 secret-shaped 内容，命中则拒绝写入。

### CTX-OBS-05 估算与实报分列

- 触发：组/观察组装。
- 规则：v1 固定 `utf8_bytes_estimate_v1`（`tokens = UTF-8 字节数` 的保守显示计数），标签明确“UTF-8 字节估算”；provider usage 独立字段并排展示，**从不**分摊到组；未知模态 → `estimated_tokens:null`、`complete:false`、列入 `unpriced_modalities`（如图片）。
- 失败恢复：窗口未知不画“剩余 X tokens”；组估算之和与 provider usage 不要求相等，不推倒计费。

### CTX-OBS-06 有界缓存、revision 与去重

- 触发：每次观察写入/读取。
- 规则：单会话最多 8 份、2 MiB；全插件 32 MiB 按整会话 LRU 淘汰；重复 key+digest 去重不复制快照；超限先裁 preview/丢弃尾部组并记 `truncated/omitted_bytes`，同步置 `estimate.complete=false/tokens=null`（不伪造完整性）；不存正文（除 preview）。
- 状态：每会话 revision、观察 ID、订阅通知；session disposed/rewind 事件先失效再重读。
- 失败恢复：缓存不落盘，重启为空并显示“尚未观测”；旧代次/revision 不匹配 → stale，不把缓存当最新。

### CTX-OBS-07 正文分页（group.read）

- 触发：用户展开组。
- 前置：观察 ID 属于该绑定/session/generation；组存在；重新读取 live surface 后 boundary **必须**等于观察 boundary，否则 stale。
- 规则：按 UTF-16 码元分页，`offset` 落在低代理项时回退到配对起点，页尾不截半代理对；默认 8192、上限 32768；`next_offset=null` 表示结束。
- 失败恢复：surface 已变 → `STALE_OBSERVATION`，客户端刷新后重新展开；不返回旧正文。

### CTX-OBS-08 本地报告导出

- 触发：用户显式点击导出；宿主从不自动导出。
- 前置：binding 的 `export_root_refs` 包含 `output_ref`；observation/revision 匹配；报告 schema 严格校验。
- 动作：root 绝对路径 + 目标路径包含性校验（拒绝越界/非普通文件/符号链接父或目标）→ 同目录临时文件→写入→fsync→close→rename→目录 fsync 尽力；已存在同内容 → saved 同 digest；不同内容 → conflict 不覆盖；wire 只回 root-relative 名称+digest。
- 失败恢复：写失败 → 固定 INTERNAL_FAILURE/EXPORT_CONFLICT，不自动重试；部分写不会留下正式文件名（临时文件隔离）。

### CTX-OBS-09 浏览器传输与 owner 门禁

- 触发：client 调四端点。
- 规则：`POST /api/context-mng/<endpoint>`；Host 共享 `/api` handler 先做 Host/Origin fence 与 cookie 认证（未认证 401），再对非 owner principal 403，然后才调用插件路由；请求体严格 schema（额外 caller/principal/grant 字段一律拒绝）。业务拒绝为 HTTP 200 + 固定 `status/reason_code`；`caller` 记录 Host owner 门禁结论（exact route 不传 peer），registry 仍是唯一范围权威。
- 失败恢复：非 2xx/坏 JSON/坏 BusinessResponse → 客户端固定 `TRANSPORT_FAILURE`，不显示原 message/details；写操作（导出）不自动重发。

### CTX-OBS-10 Client 视图 epoch、轮询与取消

- 触发：面板打开/会话切换/暂停/关闭/卸载。
- 规则：view epoch + AbortController；切会话/关面板/撤权 → abort+epoch+++清正文；晚到响应如 epoch/generation/operation_id 不匹配直接丢弃；同 view 最多 1 个在途 `observation.get`；500ms 轮询仅在 `document.visible && panel active && !paused`；`group.read` 分页缓存随新观察清理。
- 失败恢复：业务拒绝映射显式状态（denied/stale/unavailable/error）；传输失败固定码；不自动重试导出；面板关闭恢复 `selectPanel(null)`。

### CTX-OBS-11 生命周期、dispose 与降级

- 触发：插件加载/卸载、session 生命周期事件。
- 规则：所有资源经 `ctx.effect`/`ctx.on` 注册并在 dispose 释放（路由、监听、timers、locale、slots、store、registry）；observer 失败不令主模型请求失败；缺少 Web 载体时仅保留观察能力（降级），缺少安全边界（registry/RPC 不可用）时报错而非放宽。
- 失败恢复：卸载后不再采样/推送；重启显示“尚未观测”，不恢复“活跃”标签；不修改会话内容。

### CTX-MAINT-01 维护（后置、首版禁用）

- 配置 `maintenance.enabled` 只能为 false（否则插件激活失败）；没有 Host 共享运行租约/flush 证据前不开放任何写路径。用户确认首版只读，维护另行增量。

## 4. 来源与设计原因

| 来源 | 借鉴的机制 | 实际采用 | 原因/代价 |
|---|---|---|---|
| 本机安装 DSH 0.2.1-rc.5（MIT） | cordis 生命周期、Session surface/deriveMessages、`llm/stream` waterfall、`agent/pre-step`、Connection Fetch/认证 | 薄适配（`host-rc5.mjs`、`transport.mjs`、`client.js`） | 使用真实安装字节，避免复制 Host；代价是版本锁 rc.5，升级需重核。实测 `rpc.handle` 不可用后改用 exact Fetch routes（见 CTX-RPC-03）。 |
| dsh-context 0.80.3 固定树（Apache-2.0） | 来源组成/估算展示、只读面板组织 | 仅借鉴机制，未复用源码/资源 | 产品需要自有 schema/分类/权限边界；代价是自行实现分类器与面板，收益是可控数据边界。 |
| dsh-context-manager | 观察与维护分离的对照 | 仅调查 | 无固定构件/许可证据，不作依赖。 |
| 05 本地记忆证据 | Session/LLM 边界、Provider 结果语义 | 只读引用 | 不继承 05 业务授权。 |

## 5. skill 改进接口（可调 vs 硬边界）

**可由 skill/配置调整（不触碰权限与事务）**

| 参数/接口 | 位置 | 默认 | 说明 |
|---|---|---|---|
| 自动 surface 采样开关 | `config.capture.autoSampleSurface` | true | 关后仅按需/事件驱动 |
| 请求/预步骤观测开关 | `config.capture.requestObservation` / `agentPreStep` | true | 关后对应阶段无新观察 |
| 事件合并窗口/刷新率 | `config.capture.coalesceWindowMs`(10–1000) / `maxRefreshHz`(1–20) | 100ms / 10Hz | 影响刷新及时性与开销 |
| 绑定登记 | `config.access.registry` | 空 | 必须显式登记；空=不可见 |
| 估算标签措辞/分组展示顺序 | `ui/context-panel.js` + locale | 现状 | 只改展示，不改数字语义 |
| 轮询间隔 | `ui/context-store.js` `POLL_INTERVAL_MS`（settings 可传） | 500ms | 前端行为 |
| 分页大小 | `LIMITS.groupPageDefault/Max` | 8192/32768 | 大文本阅读体验 |
| 缓存/预览上限 | `src/contracts.mjs` `LIMITS` | 见 §4/代码 | 工程上限，调整需同步测试 |

**硬边界（skill 文本不能改；改动须改代码并重验）**

- scope/绑定校验与 owner 门禁（`src/access.mjs`、`src/transport.mjs`、Host `/api` handler）：skill 不能新增/放宽绑定、不能从正文/cwd/前端参数推断授权。
- 秘密过滤与导出出口（`src/redact.mjs`、`src/export.mjs`）：不能“先展示后过滤”或导出未过滤内容。
- 只读：不修改 prompt/消息/stream/会话；`utils` 不允许 append/写 session。
- 传输与错误映射（`src/transport.mjs`、`src/rpc.mjs`）：固定 endpoints/reason codes，异常不得透传原文。
- 报告原子性与幂等（`src/export.mjs`）：不允许覆盖不同内容或跳过 fsync。
- 维护写路径（`maintenance.enabled=false`）：无运行租约/flush 证据前不得开放。

## 6. 证据与下一次验证

| 证据 | 证明什么 | 没有证明什么 |
|---|---|---|
`evidence/task1-*.tap`（46 tests） | 分类/脱敏/估算/投影/未知/截断/去重摘要的纯核心行为 | 真实 Host 采样 |
`evidence/task2-cache.tap`/`task2-capture.tap`（33 tests） | 有界缓存、去重、透明 stream、取消/迟到 usage、dispose | 完整 AgentLoop 单轮 |
`evidence/task2-probe.json`（28 checks） | 用**实际安装 rc.5 字节**跑真实 Session/deriveMessages、cordis waterfall、真实 SessionStore+我们的 capture；pinned SHA256 全对 | 真实模型/网络/完整 Host 轮次 |
`evidence/task3-tests.tap`（41）+ `task3-smoke.txt` | 导出原子/幂等/路径防护、client 模块契约、epoch/传输错误、面板状态、网络 0 尝试（Node API 级） | 真实 Chromium 页面与 CSP |
`evidence/task4-full-suite.tap`（175） | 全仓库组件/合同回归 | Host/OS 级保证 |
`evidence/task4-host-rpc.txt` | 隔离 rc.5 web Host 真实启动、cookie 认证、`/api/context-mng/*` 路由、BusinessResponse、伪造字段/未知 endpoint/未认证/未登记/无 live session 的拒绝路径 | Chromium 面板渲染与真实用户旅程 |
`docs/task2-evidence.md`、`docs/task3-evidence.md`、`docs/task4-evidence.md` | 命令、退出码、限制与未验证项 | — |

**下一步最小验证（改进假设）**

1. 在真实 Chromium（现有 Harness Web UI）加载 client bundle，验证 main slot 注册、owner gate 下的真实 fetch/CSP `connect-src`、暂停/切会话/关闭旅程；最小反例：CSP 拦截导致 TRANSPORT_FAILURE 时面板是否正确显示固定错误。
2. 用真实已注册 Provider 的合成会话跑一次 `llm/stream` 观测，对比 provider usage 与 UI 实报、确认 wire_verified=false 标注不被误读（不采集用户原会话）。
3. Host 完整 AgentLoop 单轮的 `agent/pre-step` 真实语义（当前仅合成 waterfall）；最小反例：pre-step 决定 reject 时插件不得采样/阻塞。
4. 升级 Harness 后重核 `rpc.handle` 是否修复；若修复可回退 CTX-RPC-01 形态并重跑 host-rpc 证据。
5. `unpriced_modalities` 的 UI 解释与 locale 字段标签补充（当前部分枚举按机器 token 展示）。
