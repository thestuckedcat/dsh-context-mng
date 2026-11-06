# T1 证据：纯投影核心（redact / estimate / classify / projection）

版本：CTX-EVID-T1-1；日期：2026-11-07；归属：core-projection（task-1）。
范围：CTX-01、CTX-02 的纯核心部分（来源/估算/实报阶段分离、秘密过滤、A/B 边界、截断与未知）。未包含 rc.5 Host 接缝（T2/T3）、真实 UI/出口（T3/T4）。

## 1. 运行环境与命令

| 项 | 值 |
|---|---|
| 工作目录 | `E:\dsh\plugin\07-context-management` |
| 运行时 | `node v26.13.0`（`node --version`；设计基线 ≥24.9，本机无 Node 24，见 `docs/compatibility.md`） |
| 操作系统 | Windows（本机） |
| 网络/模型/真实会话 | 未使用。所有秘密为合成假值，所有会话为合成 fixture |
| 测试临时产物 | 仅写 `$env:TEMP`；本目录内交付文件用文件工具写入 |

验收命令（本机 Windows + DSH 沙箱实测）：

```powershell
node --test --test-isolation=none tests/projection.test.mjs tests/redact.test.mjs tests/estimate.test.mjs
```

结果：**exit code 0，tests 46 / pass 46 / fail 0 / cancelled 0 / skipped 0 / todo 0**。

说明：直接 `node --test tests/...` 在本机失败于 `Error: spawn EPERM`——DSH Windows 沙箱阻止测试运行器派生被管道捕获的子进程；这是本机测试框架限制，不是插件行为。Lead 已验证 `--test-isolation=none` 形式可用，因此验收使用该形式。该差异不影响被测模块语义（文件在同一进程内执行）。

逐文件命令与结果：

| 命令 | exit | tests | pass | fail | skip | TAP 证据 |
|---|---|---|---|---|---|---|
| `node --test --test-isolation=none tests/projection.test.mjs` | 0 | 23 | 23 | 0 | 0 | [`evidence/task1-projection.tap`](../evidence/task1-projection.tap) |
| `node --test --test-isolation=none tests/redact.test.mjs` | 0 | 13 | 13 | 0 | 0 | [`evidence/task1-redact.tap`](../evidence/task1-redact.tap) |
| `node --test --test-isolation=none tests/estimate.test.mjs` | 0 | 10 | 10 | 0 | 0 | [`evidence/task1-estimate.tap`](../evidence/task1-estimate.tap) |
| 三文件合并（验收命令） | 0 | 46 | 46 | 0 | 0 | 三个 TAP 之和；合并运行的 summary 与逐文件一致 |

证据文件由 `node --test --test-reporter=tap` 输出到 `$env:TEMP` 后用文件工具原样落盘；读取校验：三份文件与临时捕获内容逐字符一致（仅 CRLF→LF 行尾归一）。TAP 中的 `duration_ms` 是捕获时实际值。

## 2. TDD 过程（先失败后实现）

1. 先写三个测试文件并运行：3 个文件均失败于 `ERR_MODULE_NOT_FOUND`（`src/projection.mjs` / `src/redact.mjs` / `src/estimate.mjs` 尚不存在），exit 1。
2. 实现后再跑：38 pass / 1 fail。失败为 `redaction is idempotent: a second pass finds nothing`（期望 0，实际 2）——URL 密码规则会把 `[REDACTED:url_password]` 占位符（内含 `:`）当作新的 userinfo/密码再脱敏一次。
3. 修复：URL 规则排除方括号并加 `(?!\[REDACTED:)` 守卫，使脱敏幂等；复跑 46 pass / 0 fail，exit 0（即上表结果）。

## 3. 交付物

| 文件 | 内容 |
|---|---|
| `src/estimate.mjs` | `utf8Bytes`、`estimateGroupText`、`combineEstimates`；方法恒为 `utf8_bytes_estimate_v1` |
| `src/redact.mjs` | `createRedactor({policyRevision?})` → `{policyRevision, redactText}`；REDACT-1 确定性、幂等、不记录原文 |
| `src/classify.mjs` | `classifyMessage(message, {toolNames?})`；优先级 = 可信 Host source 白名单 → 05 标记白名单前缀 → role 结构启发 → unknown；正文永不参与分类 |
| `src/projection.mjs` | `projectMessages`、`collectGroupTexts`、`computeObservedDigest`；确定性分组/摘要/digest、上限截断、图片/文件不计价 |
| `tests/{projection,redact,estimate}.test.mjs` | 46 个无网络、无真实模型/会话的用例 |
| `schemas/observation.schema.json` | ContextObservationV1 严格 schema（拒绝额外字段，联合 rc.5 消息/内容形状） |
| `schemas/report.schema.json` | ContextReportV1 严格 schema；`observation` 通过相对 `$ref` 引用 observation schema（单一事实来源） |

## 4. 关键行为与设计决定（供 T2/T3/评审复核）

1. **估算语义**：`tokens` = 已脱敏显示文本的 UTF-8 字节数；`characters` = UTF-16 code unit 数（与 `group.read` offset 同单位）。不是 tokenizer，不用于计费/窗口利用率换算。
2. **未知保持未知**：图片 `image`、文件 `file`、未知内容块 `unknown_block:<type>` 一律不计价；含未计价模态的组 `estimated_tokens:null`。若任一组未知，顶层 `estimate.tokens:null`、`complete:false`、`unpriced_modalities` 排序列出。已知文本字节仍可通过 `totals.bytes` 与各组 `bytes` 查看，绝不把它冒充完整估算。
3. **provider usage 不分摊**：`projection` 无 usage 输入；`reported_usage` 只属于 observation 的独立字段（capture 组装）。测试用 987654 等假 usage 证明投影不变。
4. **分组**：每个 `(category, source_kind, source_ref)` 一个确定性组，`group_id = category|source_kind|source_ref`（空用空串；超长成分用 48 字内前缀+sha256 摘要，保证 ≤128 字符）。同一 surface 重读得到相同 ids；新增消息不改变已有 provenance 组的 id。分类映射见 `src/classify.mjs` 的 `TRUSTED_SOURCE_CATEGORIES`。
5. **分类事实来源**：rc.5 `MessageSourceMap`/`ContentBlockMap`/`ToolSchema` 类型声明（`docs/compatibility.md` §5，安装字节只读核对）。`skill-invocation`→developer；`session-reference`→memory（Host 原生 recall，UI 应以 source_kind 区别于 05 标记）；`compact-checkpoint` 无 v1 组合桶 → `category:'unknown'` 且 `certainty:'identified'`（知道来源、不虚构桶）；`agent-message`/`team-message`/`webhook`/`user-question-reply`→user；其余 Host 上下文来源→developer。05 白名单只接受显式前缀 `memory-injection`/`memory-recall`（含 `-suffix` 变体），`memory-hint` 等回退 role 启发。
6. **正文不决定来源/权限**：含 "SYSTEM PROMPT"/"memory"/"secret"/"skill" 字样的正文，无 source 时仍只按 role 分类；未知 role 且无 source → unknown/unknown。未知标签记录到 `source_kind` 但不提升 category（certainty 保持 heuristic）。
7. **截断**：`maxTextCharsPerGroup` 上限截断组全文（不切半代理对），置 `group.truncated`、顶层 `truncated`、`omitted_bytes` = 被省去脱敏文本的 UTF-8 字节数；`maxGroups` 超限丢弃尾部组并同样记账；`message_refs` 上限 10000。**预览截断（`maxPreviewChars`）是正常窗口，不算数据丢失**：`group.truncated` 只为内容上限/丢组置真，UI 可比较 `preview` 长度与 `characters` 判断预览不完整。
8. **observed_digest**：`sha256(canonicalJson({groups(redacted summaries), estimate, totals, truncated, omitted_bytes, redaction_total, unpriced_modalities}))`，groups 的 digest 形式不含 `message_refs`、时间、request/provider/model refs、原始文本；脱敏后内容相同（即使消息 id 不同、原秘密不同）digest 相同，不构成原文 hash oracle。`computeObservedDigest(fragment)` 导出给 store 层在必要裁剪后重算，保证“裁剪后的 groups + 裁剪后的 digest”一致。
9. **策略注入**：`policy.redactionPolicyRevision` 进入报告；`policy.redactor` 可注入（capture 复用同一 redactor），默认使用 REDACT-1。`limits` 只接受 `maxPreviewChars`/`maxTextCharsPerGroup`/`maxGroups` 并夹紧到 `contracts.LIMITS`。
10. **schema 与 contracts 一致性**：测试从 `projectMessages` 结果组装 observation/report，经 `contracts.validateObservation`/`validateReport` 通过，并断言两个 JSON schema 的 required/properties 键集合与运行对象完全一致（防止 schema 漂移）。

## 5. 已知限制与未验证项（诚实边界）

- **纯核心层**：本任务不读取真实 rc.5 Session/LLM、不执行 RPC/UI/操作系统出口；端到端由 T2/T3 覆盖。本证据中的"通过"只说明组件/合同层，不升级为 Host 或 GUI 验收。
- **估算不是 tokenizer**：字节数不等于任何模型真实 token；未锁定 tokenizer（`locked_tokenizer` 未实现，属后续轮次）。不承诺窗口利用率/费用。
- **未知模态不细分**：图片/文件不按 request 图价或 handle 文本计价；同组含未知模态时整组估算 null（不再拆消息级子组，避免暗示精度）。
- **脱敏是显示过滤，不是唯一隔离**：REDACT-1 按已知形状识别（PEM 私钥、赋值语句、URL 密码、Bearer、JWT、常见 provider 前缀），并整值移除（不像 Host 客户端 secret-mask 保留前 8 字符，因为本插件会持久化导出报告）；未登记形状/自定义密钥格式可能漏过。真正的权限/出口边界由 access、Host RPC 与 T4 出口验收承担；本模块不读取凭据、不联网。
- **分类白名单是 rc.5 固定枚举**：rc.5 `ContentBlockMap` 可合并扩展；未登记的新 source kind / block type 会落到 heuristic/unknown 或 `unknown_block:<type>`，不会猜。`toolNames` 参数按接口接受但不影响分类（避免无关名称影响来源判定）。
- **每个 provenance 桶而非每消息一个组**：这是可修改默认值（产品展示按来源组成），组内 `message_refs` 提供消息级追溯；如 UI 需要消息级展开，可在不破坏合同的前提下另加投影视图。
- **上限类路径**（`maxGroups` 丢弃尾部组、`message_refs` 10000）在正常会话不可达，只有合成用例覆盖；`maxGroups` 场景已测（2 组上限、truncated/omitted 记账）。
- **本机 Node 26 非 Node 24**：仅补充运行，不构成 Node 24 兼容声明；`--test-isolation=none` 是本机沙箱下的测试运行形式（见 §1）。
- 未做性能基准：REDACT-1 对 4Mi 字符组文本为多次线性正则扫描；未测量大输入耗时（工程上限不会无限放大）。

## 6. 复跑方式

```powershell
cd E:\dsh\plugin\07-context-management
node --test --test-isolation=none tests/projection.test.mjs tests/redact.test.mjs tests/estimate.test.mjs
# 或逐文件：
node --test --test-isolation=none --test-reporter=tap tests/projection.test.mjs
node --test --test-isolation=none --test-reporter=tap tests/redact.test.mjs
node --test --test-isolation=none --test-reporter=tap tests/estimate.test.mjs
```

## 7. 待 Lead/评审确认的可修改默认（非阻塞）

1. 分组粒度 = provenance 桶（见 §4.4/§5）；若产品确认需要消息级组，可加视图而不改合同。
2. “任一未计价模态 → 顶层 `estimate.tokens=null`” 的聚合语义（§4.2）；备选是保留文本字节数并只置 `complete:false`，但会弱化“未知模态计数为 null”的设计表述。
3. `session-reference`→`memory`、`compact-checkpoint`→`unknown+identified`、`subagent-settled`→`developer` 的映射属于可调整分类规则（§4.5）。
