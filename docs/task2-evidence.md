# 07 T2 证据：rc.5 Host 捕获、有界观测缓存与安装字节探针

版本：CTX-T2-EVIDENCE-1；日期：2026-11-07；任务：`task-2`（T2/CTX-03 + T3 的缓存部分）；执行者：`host-capture`。
环境：Windows，本机 Node `v26.13.0`（设计基线 Node 24 未安装，仅记录差异）；已安装 Harness `0.2.1-rc.5`（`E:\dsh\resources\app.asar`，182,766,714 bytes）。全部命令工作目录 `E:\dsh\plugin\07-context-management`；测试/探针临时产物只写入 `$env:TEMP`，仓库内证据由文件工具写入。

证据分层（不合并计数冒充系统认证）：

| 层 | 本轮状态 | 说明 |
|---|---|---|
| 组件/合同（假 Host 适配器） | **已执行通过** | `tests/cache.test.mjs`、`tests/capture.test.mjs`（无网络、无真实模型/会话） |
| rc.5 安装字节（asar 抽取的真实包字节） | **已执行通过** | `tools/probe-host.mjs`：真实 `dsh-session`/`dsh-llm`/`cordis` 字节 + 真实 `ctx.waterfall` 派发 + 假 provider adapter |
| 完整 Host / AgentLoop / GUI / Chromium / 出口 | **未执行（not_run）** | 未启动 rc.5 AgentLoop turn、未调用真实模型、未做 GUI 旅程与网络出口验收；不得由低层通过升级为系统认证 |

## 1. 交付文件（本任务写入范围）

| 文件 | 内容 |
|---|---|
| `src/observations.mjs` | 有界观测缓存：每会话单调 revision、stage/request/boundary/observed_digest 去重、≤8 份/会话、≤2MiB/会话、≤32MiB 总量整会话 LRU、订阅/失效/dispose、截断时诚实标 `truncated`/`omitted_bytes` 并重算摘要（不伪造完整性） |
| `src/host-rc5.mjs` | rc.5 只读接缝薄适配：`sessions.get/list`、`readBoundary`（仅元数据）、`readSurface`（`deriveMessages` + `surface.contentGeneration` + `session.seq` + header + 请求头工具定义）、`onSessionEvent`（`session/event` + `session/disposed`）、`onLlmStream`（恰好一次 `next()` 的透明中间件）、`onAgentPreStep`（只标阶段、原样返回既有决定）、非秘密日志码 |
| `src/capture.mjs` | 授权先于正文；边界前后比较 + 一次重试再 stale；`session_surface` 投影；`llm/waterfall` 请求观测（`request_observed`/`wire_verified:false`、本地单调 request_ref、usage 映射、取消后迟到 usage 归原请求且 `is_final:false`）；`agent_pre_step` 仅阶段标记；事件合并 100ms/默认最高 10Hz、每会话最多一个采样；替换/移除先失效再重采；缓存写入前复核 scope generation；`readGroupTexts` 重读当前 surface 并核 boundary |
| `tests/cache.test.mjs` | 14 个缓存合同测试 |
| `tests/capture.test.mjs` | 19 个捕获/透明性/隔离测试（假 Host ctx 实现 rc.5 的 `ctx.on` 与 waterfall `(options,next)` 语义） |
| `tools/probe-host.mjs` | 只读 asar 头解析、固定摘要校验、所需包闭包抽取到临时目录（支持 `unpacked` 条目）、真实 Session derive 冻结快照、真实 cordis + dsh-llm waterfall 透明性、本插件 capture 跑在真实 SessionStore 上 |
| `evidence/task2-cache.tap` | 缓存测试 TAP（14 pass） |
| `evidence/task2-capture.tap` | 捕获测试 TAP（19 pass） |
| `evidence/task2-probe.json` | 机器可读探针证据（命令、哈希、闭包、28 项逐项 pass/fail/skip、层标签、限制） |
| `docs/task2-evidence.md` | 本文件 |

未改动 `src/contracts.mjs`、`src/access.mjs`、`src/service.mjs`、`src/rpc.mjs`、`index.js` 或其他队友文件；`.work07/` 的只读抽取物未复制进交付物。

## 2. 命令与结果（精确命令、退出码、pass/fail/skip）

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `node --test --test-isolation=none tests/cache.test.mjs` | 0 | 14 pass / 0 fail / 0 skip（TAP 见 `evidence/task2-cache.tap`） |
| 2 | `node --test --test-isolation=none tests/capture.test.mjs` | 0 | 19 pass / 0 fail / 0 skip（TAP 见 `evidence/task2-capture.tap`） |
| 3 | `node --test --test-isolation=none tests/cache.test.mjs tests/capture.test.mjs` | 0 | 33 pass / 0 fail / 0 skip / 33 tests |
| 4 | `node tools/probe-host.mjs --asar "E:/dsh/resources/app.asar" --out "$env:TEMP\task2-probe.json"` | 0 | 28 pass / 0 fail / 0 skip；`ok:true`；证据 `evidence/task2-probe.json` |
| 5 | `node -e "import('./index.js')"`（glue 兼容性冒烟，不启动插件） | 0 | `RPC_CHANNEL,apply,inject,name` 导出；本任务模块与 Lead 的 service/rpc/export/projection glue 可一起加载 |
| 6 | `node --test tests/cache.test.mjs`（无 `--test-isolation=none`） | 1 | `Error: spawn EPERM`（DSH Windows 沙箱禁止测试运行器创建子进程；环境限制，不是插件/测试失败）。等价命令 `--test-isolation=none` 退出码 0 |

TDD 记录：先写失败用例并确认红（`ERR_MODULE_NOT_FOUND: src/observations.mjs`、`src/host-rc5.mjs`），再实现至上述全绿；`tests/capture.test.mjs` 的失败用例覆盖未绑定会话零读取、边界变化重试一次后 stale、透明 stream（对象同一性/顺序/数量/单次 next/错误透传/usage 迟到归属）、合并限频、监听器释放等。

## 3. 探针（安装字节层）逐项结果

命令：`node tools/probe-host.mjs --asar "E:/dsh/resources/app.asar"`（工作目录 `E:\dsh\plugin\07-context-management`）。它只读解析 asar 头，抽取所需包闭包到系统临时目录（抽查 `dsh-session/lib/index.js` 抽取字节摘要与固定值一致），完成后清理临时目录；`--keep` 可保留，`--out` 指定证据 JSON。

**固定摘要（全部通过，与 `docs/compatibility.md` §1 逐字节一致；来源为文档表格本身，探针先解析文档再比对）**

| 文件 | SHA256 | 结果 |
|---|---|---|
| `dsh-client-connection/lib/index.js` | `0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684` | pass（44,434 B） |
| `dsh-client-connection/lib/client.browser.js` | `dfc3544eb894c74b340a4c4c63a8c125fd2e983df9efed5885712574af994e62` | pass（60,601 B） |
| `dsh-client-ui-layout/lib/client.js` | `eb011a7b5699fac7f3ad0aa15408f46a6cf47f79b8cc15db1f81739e81e70587` | pass（32,834 B） |
| `dsh-client-ui-renderer/lib/client.js` | `dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356` | pass（78,299 B） |
| `dsh-session/lib/index.js` | `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf` | pass（94,982 B） |

其他基线：`app.asar` SHA256 `e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915` 与 `docs/software-design.md` §2 固定值一致；`dsh/package.json` 版本 `0.2.1-rc.5`；asar 头 4,760,404 B、data 起点 4,760,412、条目 18,234（其中 unpacked 条目 1,583）。

**包闭包**：13 个包（`dsh-session`、`dsh-llm`、`cordis@4.0.5` + `dsh-brand`、`dsh-util-values`、`dsh-scope`、`dsh-util-crypto`、`dsh-timeout`、`dsh-typert-protocol`、`schemastery@3.18.5`、`zod@4.4.3`、`@standard-schema/spec@1.1.0`、`cosmokit@1.8.6`），无缺失；抽取 1,221 个文件 / 10,435,688 B，跳过 0。本轮闭包内没有 `unpacked:true` 条目（`from_unpacked:0`），但抽取器已实现：遇到 `unpacked` 条目从 `<asar>.unpacked/<relpath>` 读取（整包内共有 1,583 个 unpacked 条目，如 `libreoffice-kit`、`dsh-session-log-export/node_modules/fflate` 等，只是本探针闭包不需要）。

**真实 Session 字节（`@deepseek-ai/dsh-session`）**

- `Session.create(...)` + `session.append('user/message', ..., {surfaceOp:'append'})` 成功；普通 append 不增加 `surface.contentGeneration`（为 0），`session.seq` 递增。
- `deriveMessages()` 每次返回**新数组**，而消息对象为**共享 deep-frozen**：消息、`content` 数组、内容块均 `Object.isFrozen === true`；写消息/内容块抛 `TypeError`，会话 append-only 日志未被修改。
- 旧快照稳定：后续 append 不会增长/修改先前数组，未变化消息保持对象同一性。
- 真实 `SessionStore` + 真实 cordis `Context`：`ctx.on('session/event', (session,event))` 收到真实 append 事件；活会话 `deriveMessages()` 同样冻结。
- 本插件 `captureSurface` 在真实活会话上产出通过 `validateObservation` 的 `history_projection` 观测（boundary 的 `last_event_seq`/`surface_generation` 与真实会话一致）；`readGroupTexts` 重读真实 surface 返回脱敏分组文本；真实 `session/event` 派发触发一次合并后台采样并产生新 revision。

**真实 cordis + `@deepseek-ai/dsh-llm` waterfall（假 provider adapter 取代模型网络）**

- 真实 `new Context()` + 真实 `LlmRuntime` + `registerAdapter(['probe-fake'], fakeAdapter)`；真实调用链 `llm.stream(options)` → `streamWithRegistration` → `ctx.waterfall(this,'llm/stream',options,next)`。
- 透明性：下游 stream 只创建 1 次，插件中间件在真实链上恰好前进一步（`chain_next_calls:1`），日志无 `LLM_NEXT_CALLED_TWICE`；5 个 chunk 原对象、原顺序、原数量 yield；`options` 前后 JSON 完全一致且 `messages[0]` 对象同一。
- usage 捕获：真实 waterfall 返回的流被本插件包一层透明 AsyncIterable，`usage` chunk 被映射进 `reported_usage`（input 21 / output 7 / cached 4 / `source:'provider_usage_chunk'` / `is_final:true`），观测通过合同校验，`request_ref` 为本地单调序号 + 会话 + scope 代次。
- 主请求错误透传：内层中间件返回的流在 1 个 chunk 后抛哨兵错误，外层透明包装原样抛出同一 Error 实例（未吞错）。
- 未绑定会话：`options.sessionId` 未登记时直接透传原始流，无包装、无观测、无正文投影。

## 4. 关键正确性要求与证据对应

| 要求 | 实现 | 证据 |
|---|---|---|
| access 先于任何正文读取；未绑定会话永不采样 | `capture.recheckBinding` 在 `deriveMessages`/`options.messages` 之前；事件处理先查 `access.bindingForSession` 再看 `event.data` | `captureSurface denies unbound sessions before any content read`、`background sampling only touches authorized sessions`、`llm/stream middleware leaves unbound sessions completely untouched`、`readGroupTexts denies revoked bindings before reading the session` |
| deriveMessages 前后读边界；变化重试一次后 stale | `sampleSurface` 两次边界读 + 一次重试；仍变化返回 `stale/STALE_OBSERVATION` 且不投影/不缓存 | `a surface change during deriveMessages retries exactly once`、`a boundary that keeps moving is reported stale after one retry and never cached` |
| 透明 stream：不整段缓冲、不改 chunk/options、恰好一次 next | `observeLlmStream` 逐项 yield 同一对象、只记 `usage`/`finish` 元数据；host 守卫 `next()` 只真实调用一次 | `llm/stream middleware is transparent and captures provider usage after completion`；探针 `llm.chunk_identity_order_count`、`llm.waterfall_single_next` |
| 采样失败只丢本插件观测、不吞主请求错误 | observer/projection/finalize 均 try/catch + 非秘密码；下游错误原样重抛 | `main-request errors pass through and observation failures never break the stream`；探针 `llm.main_error_passthrough` |
| 取消后迟到 usage 归原请求且非 final | 每 stream 闭包持有 request_ref/usage；`is_final = completed && !signal.aborted` | `late usage after cancellation stays with the original request and is non-final` |
| 合并 100ms / 最高 10Hz（可配）；每会话最多一个采样 | `scheduleSample`/`runScheduledSample`；并发 `captureSurface` 共享 in-flight promise | `session events coalesce into one sample per window and stay under the refresh rate`、`concurrent captureSurface calls share one sampling run per session` |
| 有界缓存 8/会话、2MiB/会话、32MiB 总量 LRU；截断诚实 | `observations.mjs`：preview 截断→丢尾部组→`truncated/omitted_bytes/estimate.complete=false/tokens=null`，重算摘要；整会话 LRU | `per-session snapshot cap...`、`snapshot byte cap...`（两项）、`default limits keep at most 8...`、`total cache limit evicts whole least-recently-used sessions` |
| dispose 释放监听器并清正文 | capture 取消定时器/清 in-flight/注销监听；store.dispose 清空全部快照与索引 | `capture dispose unregisters every Host listener and cancels pending sampling`、`dispose clears all bodies and refuses further writes` |
| 替换/移除先失效再重采；缓存写入前复核 scope generation | 替换事件先 `invalidateSession` + epoch+1 再调度；写入前 `recheckBinding` | `surface replacement events invalidate the cached snapshot before re-sampling`、`cache write re-checks the binding generation before storing` |
| group 正文重读边界不符 → stale | `readGroupTexts` 重读前后边界并比对观测 boundary + 组 id 集合 | `readGroupTexts re-reads the live surface, matches the boundary...` |
| agent/pre-step 只标阶段、原样返回既有决定 | host 中间件仅 `fn(payload)` 后 `return next()`，不触碰 payload；capture 仅读 `agent.session.id` 与 turn/step（授权后） | `agent/pre-step is tagged ... decision is returned unmodified` |

## 5. 诚实限制（未运行/未证明项）

1. **完整 Host/AgentLoop 未运行**：没有启动 rc.5 AgentLoop turn，没有真实 `agent/pre-step` 由真实 AgentLoop 派发；该接缝仅在假 ctx 的 waterfall 语义与真实字节的 `LlmRuntime` 链上验证。`agent/pre-step` 的 payload 形状（含 `agent` 融合字段）来自安装字节源码阅读与假 ctx 回放，未由真实 turn 执行证明。
2. **未调用真实模型、无真实凭据、无网络**：provider 是假 async-iterable adapter；usage 数值为合成。`llm/stream` 观测因此固定 `request_observed` + `wire_verified:false`，不声称 provider 最终 wire 全文；多 middleware 顺序对下游 options 的影响未验证。
3. **GUI/Chromium 与 RPC 实际旅程未执行**：本任务只覆盖 Host 侧 observation store/host/capture；Connection RPC、面板、导出由 Lead/T3 队友另证，低层通过不升级为 GUI 通过。`index.js` 仅做“可加载”冒烟，未在隔离宿主启动。
4. **真实用户会话/持久化恢复未执行**：探针用安装字节构造的合成 `Session`/`SessionStore`，未读取 `~/.dsh` 现有 profile、未验证 session restore/rewind 的真实事件路径（替换事件仅用合成 `surfaceOp` 事件在假 ctx 与真实 SessionStore append 上验证）。
5. **Node 24 基线未运行**：本机只有 Node `v26.13.0`；按 `docs/compatibility.md` §1 记录差异，不构成 Node 24 兼容承诺。
6. **`node --test` 默认多进程模式在本机沙箱不可用**：`Error: spawn EPERM`（环境限制），全部测试用 `--test-isolation=none` 在进程内运行；该限制不属于插件行为，也未在原生 CI 环境复核。
7. **合并/限频测试依赖墙钟**：用 10ms 窗口 + 20Hz 上限与宽松上界断言（实测 1 次/突发、连续事件 ≤4 次）；不是精确调度器证明。
8. **缓存摘要重算的防御路径**：正常路径由 `projection.computeObservedDigest` 对截断后的投影重算；若 store 需要自行截断（绕过 capture 预拟合的调用者），使用本地 canonical-JSON 摘要作为回退，未与 projection 算法逐字节等价验证（去重语义仍保守：可能多一份 revision，不会把不同内容当相同）。
9. **探针闭包未触发 unpacked 读取**：整包 1,583 个 unpacked 条目存在，但本探针闭包均为 packed 条目；`from_unpacked:0`。抽取器已实现 `<asar>.unpacked` 回退读取（Lead 发现的 fflate 等案例），但该分支未被本轮实际取证。
10. **未验证 `Session.dispose`/fiber 卸载的真实顺序**：`session/disposed` 分支在假 ctx 与 store 层测试，未由真实 fiber 卸载触发。

## 6. 复现步骤

```powershell
# 工作目录
cd E:\dsh\plugin\07-context-management

# 1) T2 组件/合同测试（本机沙箱需 --test-isolation=none）
node --test --test-isolation=none tests/cache.test.mjs tests/capture.test.mjs

# 2) rc.5 安装字节探针（只读 asar；临时抽取到 %TEMP% 并清理）
node tools/probe-host.mjs --asar "E:/dsh/resources/app.asar" --out "$env:TEMP\task2-probe.json"

# 3) 查看机器可读证据
Get-Content "$env:TEMP\task2-probe.json" -TotalCount 40
```

证据文件：`evidence/task2-cache.tap`、`evidence/task2-capture.tap`、`evidence/task2-probe.json`（本目录）。
