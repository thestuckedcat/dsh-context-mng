# 上下文观察与维护独立开发计划

> 执行约定：先只读观测，再独立开发可控修改；全部任务未执行。

2026-11-06设计入口：[software-design.md](docs/software-design.md)。用户已明确首版只读观察，手动压缩后续增量。编码接口、schema、模块职责、Host兼容后备和需求ID映射以该设计为依据；本PLAN旧任务作为分阶段索引，未发生功能实现。

**Goal:** 本地查看模型上下文的组成、来源和演进，并按需提供可预览的手动压缩。
**Architecture:** 原生 DSH Host/client plugin 读取投影并提供面板；可选压缩是另一个有明确写权限的子模块。长期记忆归05，不由本项隐式导入。
**Tech Stack:** 固定 Node >=24.9、DSH实际安装版、锁定 dsh-context 最小适配；测试 ESM + 本地宿主fixture。
**Spec:** [上下文设计](../docs/ecosystem-learning-design.md) §6；[共同约束](../docs/development-contract.md)。

## Global Constraints

- 首版只读；prompt prefix/suffix固定空，不修改Provider、上下文或持久历史。
- 估算token、provider实报token、活跃请求和历史快照分别标注，不能声称面板估算等于真实计费。
- UI展示/导出也要scope和秘密过滤；全文不发额外分析服务。
- 当前无实现。Windows验证命令用 .\runtime\node.exe，Linux用 ./runtime/node；离线准备任务先锁DSH/运行时与构件。

## Review Focus

1. A会话面板不能读B会话，也不能在切换后显示B全文 → CTX-01。
2. 可选prefix/suffix遗留配置不能让只读模式改变请求 → CTX-02。
3. preview后发生新turn/rewind/provider切换，apply必须拒绝 → CTX-03。
4. 压缩不能破坏tool-call/result配对或丢当前指令 → CTX-03。
5. dispose/多视图/巨大输出不残留订阅或无限复制上下文 → CTX-02。

## Task 1：固定投影接口与只读模型（CTX-01）

**Files:** Create source-lock.json, package.json, src/projection.mjs, src/redact.mjs, tests/projection.test.mjs, tests/fixtures/context/。
**Interfaces:** projectContext({sessionRef,snapshotRef,groups,usage},policy) → {snapshotRef,estimates,reportedUsage,groups,truncated}；不会暴露其他scope或完整秘密。

- [ ] 锁定 dsh-context/source与宿主模块映射，验证声明兼容和真实构件；不依赖搜索缓存里的旧API。
- [ ] 写 CTX-01：来源分类、估算与实报、A/B隔离、超限截断和假秘密；运行 .\runtime\node.exe --test tests/projection.test.mjs 确认缺实现失败。
- [ ] 实现纯投影/过滤，读不到实际投影时返回 unavailable，而不是用启发式拼装后宣称实际模型输入。
- [ ] 复跑测试并对照已锁定宿主合成请求，证明分类范围与“不知道”值清楚，未启用压缩仍可独立工作。

## Task 2：只读 Host/client plugin（CTX-02）

**Files:** Create plugin/index.ts, plugin/client.tsx, src/observations.mjs, cordis.patch.yml, tests/plugin.test.mjs, tools/observe-smoke.mjs。
**Interfaces:** registerObserver(ctx,{readOnly:true}) → dispose；subscribe(sessionRef,listener) → unsubscribe；面板所有payload绑定scope和snapshot。

- [ ] 写 CTX-02：旧配置有prefix/suffix时只读模式仍无prompt改动；重复挂载/多视图关闭/会话切换订阅清理；错误/导出无外发。先运行 .\runtime\node.exe --test tests/plugin.test.mjs 失败。
- [ ] 对候选Host投影与UI做薄适配，明确从配置层关闭未来prompt注入，避免仅隐藏界面。只在本地面板提供非秘密信息。
- [ ] 运行单测，再执行 .\runtime\node.exe tools/observe-smoke.mjs --isolated，比较实际请求快照与显示、重启/卸载与网络记录。此时可独立交付只读plugin，不依赖03/05。

## Task 3：可选受控压缩（CTX-03）

**Files:** Create src/preview.mjs, src/apply.mjs, tests/preview.test.mjs, tests/apply.test.mjs, tools/compact-smoke.mjs。
**Interfaces:** createPreview({sessionRef,snapshotRef,selection,routeRef}) → {previewId,expiresAt,replacement,evidence}；applyPreview({previewId,expectedSnapshot}) → applied|stale|denied|partial|outcome_unknown。

- [ ] 写 CTX-03：preview不修改历史，用户明确apply且agent idle才提交；新turn/03回退/provider变化、过期/已消费preview一律拒绝；缺失tool result范围不可应用。
- [ ] 模型总结只用已批准、预览时绑定的Provider与预算，不携带秘密；仅omit操作无需模型。preview包含准确待替换文字与保留说明，不自动apply。
- [ ] 以宿主持久API实现合法平衡范围checkpoint，原append-only日志保留；中途失败明确partial/unknown，preview不可盲重试或重复提交。
- [ ] 运行 .\runtime\node.exe --test tests/preview.test.mjs tests/apply.test.mjs；再用隔离宿主执行 .\runtime\node.exe tools/compact-smoke.mjs --isolated，覆盖崩溃/磁盘错/03事件在流式总结中到来。
- [ ] 本子模块无明确需求或不满足宿主API时保持未启用，不将其作为只读观测的依赖。

## 独立交付

先发布只读观察，手动压缩按单独结果验收。memory写入、回退、永久删除和自动压缩策略不由本模块越权承担。

