# 上下文观察与维护独立开发计划

> 执行约定：首版只读观察已实现、自测并同步仓库；受控维护（Task 3）按设计后置，未实现。

2026-11-06设计入口：[software-design.md](docs/software-design.md)。用户已明确首版只读观察，手动压缩后续增量。编码接口、schema、模块职责、Host兼容后备和需求ID映射以该设计为依据；本文件旧任务保留为分阶段索引。

**2026-11-07 实施状态**：只读首版已按 CTX-DESIGN-2/3/4 实现，并通过 178 项组件/合同测试、28 项已安装 rc.5 字节探针、隔离 rc.5 Host 的加载/认证/路由实测（含流式 body 硬上限）；独立复审无 Critical，2 Important/3 Minor 已修复并回归（`docs/implementation-review.md`）。交付已同步 https://github.com/thestuckedcat/dsh-context-mng 。维护（Task 3）仍未实现，`maintenance.enabled` 强制 false。证据与未验证层见 `docs/task4-evidence.md`、`docs/mechanisms.md`。

**Goal:** 本地查看模型上下文的组成、来源和演进，并按需提供可预览的手动压缩（维护后置）。
**Architecture:** 原生 DSH Host/client plugin 读取投影并提供面板；可选压缩是另一个有明确写权限的子模块。长期记忆归05，不由本项隐式导入。
**Tech Stack:** 固定 Node >=24.9、DSH实际安装版 0.2.1-rc.5；测试 ESM + 本地宿主 fixture/探针；无 npm 运行时依赖。
**Spec:** [上下文设计](../docs/ecosystem-learning-design.md) §6；[共同约束](../docs/development-contract.md)；[实现路线](docs/implementation-route.md)。

## Global Constraints

- 首版只读；prompt prefix/suffix 固定空，不修改 Provider、上下文或持久历史。
- 估算 token、provider 实报 token、活跃请求和历史快照分别标注，不能声称面板估算等于真实计费。
- UI 展示/导出也要 scope 和秘密过滤；全文不发额外分析服务。
- 只读首版已实现；本机运行 Node 26.13.0（设计基线 Node 24 未运行），Windows 命令用 `node`，测试用 `node --test --test-isolation=none`（本机沙箱限制，见证据）。维护未实现。

## Review Focus

1. A 会话面板不能读 B 会话，也不能在切换后显示 B 全文 → CTX-01/CTX-02。
2. 可选 prefix/suffix 遗留配置不能让只读模式改变请求 → CTX-02/CTX-03。
3. preview 后发生新 turn/rewind/provider 切换，apply 必须拒绝 → CTX-07（后置，未实现）。
4. 压缩不能破坏 tool-call/result 配对或丢当前指令 → CTX-07/CTX-09（后置，未实现）。
5. dispose/多视图/巨大输出不残留订阅或无限复制上下文 → CTX-04/CTX-06。

## Task 1：固定投影接口与只读模型（CTX-01、CTX-02）— 已完成

**实际文件：** `source-lock.json`、`package.json`、`src/contracts.mjs`、`src/access.mjs`、`src/classify.mjs`、`src/redact.mjs`、`src/estimate.mjs`、`src/projection.mjs`、`tests/projection.test.mjs`、`tests/redact.test.mjs`、`tests/estimate.test.mjs`、`tests/access.test.mjs`、`tests/contracts.test.mjs`、`schemas/*.schema.json`。
**Interfaces（实际）：** `projectMessages/collectGroupTexts/computeObservedDigest`、`createRedactor`、`classifyMessage`、`utf8Bytes/estimateGroupText`、`createAccessRegistry`；观察/报告/registry 严格 schema，未知字段拒绝。

- [x] 锁定 dsh-context/source 与宿主模块映射，验证声明兼容和真实构件；不依赖搜索缓存里的旧 API（`docs/compatibility.md`、`source-lock.json`）。
- [x] 写 CTX-01：来源分类、估算与实报、A/B 隔离、超限截断和假秘密；先确认缺实现失败再实现（TDD 记录见 `docs/task1-evidence.md`）。
- [x] 实现纯投影/过滤，读不到实际投影时返回 unavailable，而不是用启发式拼装后宣称实际模型输入。
- [x] 复跑测试并对照已锁定宿主合成请求，证明分类范围与“不知道”值清楚；46/46 通过（`evidence/task1-*.tap`）。

## Task 2：只读 Host/client plugin（CTX-02、CTX-03、CTX-04、CTX-05、CTX-06）— 已完成

**实际文件：** `index.js`、`client.js`、`src/{observations,host-rc5,capture,service,rpc,transport,export}.mjs`、`ui/{context-panel,context-store}.js`、`ui/context.css`、`cordis.patch.yml`、`tests/{cache,capture,export,client-contract,rpc,service,transport}.test.mjs`、`tools/{observe-smoke,context-report,probe-host}.mjs`。
**Interfaces（实际）：** `createRc5Host`（只读 surface/llm/agent 接缝）、`createCapture`（access-before-content、boundary 重核、transparent stream）、`createObservationStore`（有界/去重/revision）、`createContextService`（观察/正文/导出）、`createRpcHandler`+`createContextFetchTransport`（`/api/context-mng/*`，固定 BusinessResponse）、`createReportWriter`（原子/幂等/根内）。

- [x] 写 CTX-02：只读模式无 prompt 改动；重复挂载/多视图关闭/会话切换订阅清理；错误/导出无外发。先写失败用例再实现（组件测试全部通过）。
- [x] 对候选 Host 投影与 UI 做薄适配；从配置层拒绝维护写路径；只在本地面板提供非秘密信息。
- [x] 运行单测（178/178）、fixture smoke（9/9，出站 0）与真实安装字节探针（28/28）；隔离 rc.5 Host 加载/认证/路由拒绝路径通过（`evidence/task4-host-rpc.txt`，含流式 body 超限）；独立复审 Important/Minor 已修复并回归（`docs/implementation-review.md`）。此时只读 plugin 已可独立交付，不依赖 03/05。

## Task 3：可选受控压缩（CTX-07、CTX-08、CTX-09）— 后置、未实现

> 状态：设计明确为后置增量；用户已确认首版只读。`maintenance.enabled` 在配置层强制 false（见 `src/contracts.mjs` 与 `docs/design-change-ctx-rpc-02.md`）。没有 Host 共享运行租约/flush 证据前不开放任何写路径。

**计划文件（未创建）：** `src/maintenance/{range,preview,apply}.mjs`、`tests/maintenance.test.mjs`、`tools/compact-smoke.mjs`。
**Interfaces（设计）：** `createPreview({boundary,event_seq,method,route_ref?},caller,signal)` → `ready|denied|invalid_range|route_unavailable|outcome_unknown`；`applyPreview({preview_id,expected_boundary,operation_id},caller)` → `persisted|stale|denied|applied_unflushed|outcome_unknown`。

- [ ] 写 CTX-07：preview 不修改历史，用户明确 apply 且 agent idle 才提交；新 turn/03 回退/provider 变化、过期/已消费 preview 一律拒绝；缺失 tool result 范围不可应用。
- [ ] 模型总结只用已批准、预览时绑定的 Provider 与预算，不携带秘密；仅 omit 操作无需模型。preview 包含准确待替换文字与保留说明，不自动 apply。
- [ ] 以宿主持久 API 实现合法平衡范围 checkpoint，原 append-only 日志保留；中途失败明确 partial/unknown，preview 不可盲重试或重复提交。
- [ ] 实际共享运行租约/`flush` 语义探针通过后再实现；否则维护保持 disabled，提供可复制摘要/重新开聊作为可行替代。

## 独立交付

只读观察已交付：`docs/task4-evidence.md` 记录组件/合同、实际安装库、隔离完整 Host 三层证据，并明确未验证层（真实 Chromium 页面旅程、真实 Provider/模型请求、完整 AgentLoop 单轮、Node 24、OS 级出口）。手动压缩按单独结果验收，当前未实现。memory 写入、回退、永久删除和自动压缩策略不由本模块越权承担。
