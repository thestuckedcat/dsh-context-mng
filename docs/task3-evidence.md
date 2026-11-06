# 07 T3/T4a 证据：本地导出、原生客户端面板、CLI 报告与 fixture smoke

版本：CTX-T3-EVIDENCE-1；日期：2026-11-07；任务：`task-3`（T3 / CTX-04、CTX-05、T4a / CTX-06 可执行部分）。
运行时：Windows，Node v26.13.0（设计基线 Node 24，差异见 `docs/compatibility.md` §1）。
本文件只记录**本轮实际运行**的命令、退出码与通过/失败；未运行的旅程在 §6 明确标为未验证。

## 1. 交付文件与写作用途

| 文件 | 职责 |
|---|---|
| `src/export.mjs` | 受控本地报告写盘：`contracts.validateReport` 校验、同目录临时文件 + `fsync` + `rename` 原子提交、根内叶名/穿越/符号链接/非普通文件/超限/秘密形状拒绝、同内容幂等、异内容冲突不覆盖、返回根相对 `report_ref` + 64 hex digest（不含绝对路径） |
| `client.js` | rc.5 client 模块：`window.__ModuleLoader__.load({id:'dsh-context-mng', factory(require){…}})`；factory 无副作用；`apply` 内注册 main 面板 / sidebar.panellist / locale 字典并返回清理器；数据路径为 `POST /api/context-mng/<endpoint>`（CTX-RPC-03 修正，见 §5） |
| `ui/context-store.js` | 浏览器状态机：view epoch + AbortController、切会话/切阶段/关闭/卸载 abort 并清正文、epoch/generation/operation_id 不匹配丢弃、单在途轮询、可见且未暂停时 500ms 轮询、`group.read` 分页、导出 saved/conflict/denied 状态、失败固定 `TRANSPORT_FAILURE`、导出不自动重试 |
| `ui/context-panel.js` | 纯 `React.createElement` 面板：页头（会话/上下文/scope/stage/fidelity/观测时间）、分组占比条、UTF-8 字节估算与 provider 实报分列、显式 empty/unbound/denied/stale/unavailable/error、展开/收起、暂停/继续、导出按钮；全部可见文案走 locale `t` |
| `ui/context.css` | 仅面板类名，复用 Host 主题 CSS 变量，不加载远程/本地资源 |
| `tests/export.test.mjs` | 15 个导出用例（原子顺序、幂等、冲突、穿越、符号链接、父目录实路径、非普通文件、超限、非法 report、秘密形状、rename 失败清理） |
| `tests/client-contract.test.mjs` | 26 个 client 用例（模块格式、嵌入一致性、locale 一致性、静态出口扫描、factory 无副作用、注册/清理、fetch 契约、epoch 丢弃、transport 映射、轮询闸门、分组分页、导出状态机、面板渲染、与 `contracts.mjs` 校验一致性） |
| `tools/context-report.mjs` | `--fixture` 双合成会话只读报告 CLI；`--session-ref` 固定拒绝直读宿主磁盘 |
| `tools/observe-smoke.mjs` | 组件级端到端 smoke：A/B 隔离、未绑定不采样、dispose 监听归零、导出负例、切会话迟到丢弃、transport 固定码、`--network-evidence` 零出站调用 |

写作用域外文件未修改：`src/contracts.mjs`、`src/access.mjs`、`src/projection.mjs`、`src/redact.mjs`、`src/observations.mjs`、`src/capture.mjs`、`src/service.mjs`、`src/rpc.mjs`、`src/transport.mjs`、`src/host-rc5.mjs`、`index.js`、`package.json`、`locale/*`、其它任务文件均保持原样（`client.js` 只通过只读 import 使用它们）。

## 2. 必跑命令 1：组件/合同测试

```powershell
cd E:\dsh\plugin\07-context-management
node --test --test-isolation=none tests/export.test.mjs tests/client-contract.test.mjs
echo $LASTEXITCODE
```

| 结果项 | 值 |
|---|---|
| 命令 | `node --test --test-isolation=none tests/export.test.mjs tests/client-contract.test.mjs` |
| 退出码 | **0** |
| tests / pass / fail / skipped | 41 / **41** / 0 / 0 |
| 证据 | `evidence/task3-tests.tap` |

说明：本机 DSH Windows 沙箱阻止测试运行器的管道子进程（`spawn EPERM`），因此按 Lead 指定的
`--test-isolation=none` 运行。该参数只改变 Node 测试隔离方式，不改变任何被测代码或断言；
这是**本机执行环境限制**，不是插件行为或产品限制。

## 3. 必跑命令 2：fixture smoke + 网络证据

```powershell
node tools/observe-smoke.mjs --fixture --network-evidence
echo $LASTEXITCODE
```

| 结果项 | 值 |
|---|---|
| 命令 | `node tools/observe-smoke.mjs --fixture --network-evidence` |
| 退出码 | **0** |
| 检查 | 9 / **9 PASS** / 0 FAIL |
| 网络证据 | `fetch` / `WebSocket` / `XMLHttpRequest` / `EventSource` 与 `node:net|http|https|dns` 探针：出站尝试 **0** |
| 证据 | `evidence/task3-smoke.txt` |

9 项检查（全部真实组件、合成数据、无网络、无真实会话）：

1. `observation.get` 返回已授权会话 A 的 surface 投影；fake API key/password 被脱敏；A 观测不含 B 标记；未知来源保持 `unknown`；`capture_stage=session_surface`、`fidelity=history_projection`、`wire_verified=false`；surface 阶段不伪造 provider usage（`reported_usage=null`）。
2. A 读不到 B：A+generation(B) → `STALE_SCOPE`；model principal → `OWNER_REQUIRED`；未登记 context → `CONTEXT_UNBOUND`；用 B 的 context 读 A 的 observation_id → `STALE_OBSERVATION`；B 观测不含 A 内容。
3. 未登记会话从不被采样：`captureSurface` 返回 denied/CONTEXT_UNBOUND，Host `readSurface` 计数不变；`context.list` 不列出未登记会话，wire 不含绝对导出路径。
4. `capture.install()` 后 Host 三类监听计数 = 1/1/1，`dispose()` 后全部 = 0。
5. 本地导出经真实 `src/export.mjs` 写入 `$env:TEMP` 登记根：返回 `report_ref` 为根相对路径、64 hex digest，wire 不含绝对根；重复导出同内容 `saved` 且 digest 相同；未登记 `output_ref` → denied `OUTPUT_REF_DENIED`。
6. 导出写盘负例：`../escape.json`、`nested/report.json`、相对根、以文件为根、以目录为目标均拒绝且未写出根外文件；真实符号链接在本机因 `EPERM` 不可创建（普通用户无 `SeCreateSymbolicLinkPrivilege`），改用注入 fs adapter 证明同一分支拒绝并保持目标不变（见 §6 限制）。
7. 会话切换迟到响应丢弃：A 的 `observation.get` 在途时切到 B，A 请求 signal 被 abort；放行迟到 A 响应后 store 只显示 B 的 observation，A 标记不出现。
8. client store 传输失败固定码：非 2xx 抛错 → `error` + `TRANSPORT_FAILURE`，raw 文本/会话标记不进入 state。
9. `--network-evidence`：插件模块图（contracts/access/observations/capture/service/rpc/redact/export/ui store）在 guard 安装后动态导入并完整运行全部组件检查，出站尝试 = 0。

## 4. 补充命令：CLI 后备报告

```powershell
node tools/context-report.mjs --fixture
echo $LASTEXITCODE                                   # 0
node tools/context-report.mjs --session-ref session-x
echo $LASTEXITCODE                                   # 3（固定拒绝）
```

- 退出码 **0**；stdout 为单行 canonical JSON `ReportV1`（3607 bytes canonical）。
- 报告先通过 `contracts.validateObservation` + `contracts.validateReport`，否则 exit 4 且只打印 schema 字段路径。
- 校验不变量（由写出的 JSON 重新计算）：7 个分组，含 `unknown`；redaction_total=3；fake api_key/password/jwt 与 session B 标记均不存在；`wire_verified=false`；provider usage 独立字段。
- stderr 打印 access 层隔离负例：`STALE_SCOPE` / `OWNER_REQUIRED` / `CONTEXT_UNBOUND` / `OUTPUT_REF_DENIED`。
- `--session-ref` 固定 exit 3，信息明确说明真实会话只能经运行中 Host 的已认证 RPC/CLI 读取，直读持久目录不是授权后备（设计 §5.2）。
- `--out` 只接受 `$env:TEMP` 内路径，否则 exit 3；写入复用原子导出器。
- 证据：`evidence/task3-cli-report.txt`（命令、退出码、stderr、重算的 digest/不变量）。

## 5. 传输修正（CTX-RPC-03，Lead 提供并已按其指令实现）

Lead 在隔离 rc.5 host 上证实 `ctx.connection.rpc.handle(...)` 对 profile 插件不可用（抛
`cannot get property "webServer" without inject`），实际支持的接缝是 `connection.fetch.register(route)`
（与上游 dsh-context 一致）。因此本任务交付的 client 数据路径改为：

- 固定同源 `POST /api/context-mng/context.list | observation.get | group.read | report.export`；
- `content-type: application/json`，body 为原请求信封（`context.list` 保持不含 `context_ref` 的特殊信封）；
- 成功响应 body 是 `BusinessResponse` JSON **本身**（不再有 RpcResult 包装）：先 `response.ok`（传输），
  再校验 BusinessResponse 字段/枚举/`operation_id`/`view_epoch`，最后才看业务 `status`；
- 非 2xx、JSON 解析失败、schema 校验失败一律固定 `TRANSPORT_FAILURE`，不显示原始 message/details；
- 浏览器同源 cookie 认证 owner Peer，Host 路由对非 owner 返回 403；
- `report.export` 仍只在用户点击时调用，从不自动重试。

`client.js` / `ui/context-store.js` 与 `tests/client-contract.test.mjs` 已按上述契约更新；`inject` 列表仍按
任务硬要求保留 `['slots','layout','connection','sessions','locale']`（`connection` 现不承载数据，仅满足
插件组合契约，代码注释已说明）。`src/transport.mjs` 与 `index.js` 由 Lead 实现，其路由注册单测已包含在
全仓测试快照（§7）中；本任务 smoke 的 client→Host 路径用真实业务 handler 包一层 fake fetch，**没有**
在真实 Host 中注册 `/api/context-mng` 路由（见 §6）。

## 6. 明确未验证（不得由本证据升级为系统通过）

1. **真实 Chromium 页面旅程未执行**：没有启动 Electron/Chromium，也没有在真实 Web 页面渲染面板。面板用
   假 React 渲染树做契约断言（状态文案、按钮、估算/实报分列、无 `dangerouslySetInnerHTML`），不是真实 DOM/
   布局/键盘焦点旅程。
2. **完整 Host UI 未执行**：未在运行中的 rc.5 Host 里安装本插件并打开「上下文」面板；未验证
   `ctx.slots.register({name:'main',key:'local-context'})` / `sidebar.panellist` 的真实渲染、面板互斥切换、
   locale 语言切换、HMR/卸载后 UI 清理。`/api/context-mng` 真实 host 路由注册与认证在本任务证据之外
   （Lead 的 isolated host 启动与 `tests/transport.test.mjs` 覆盖路由部分，但不含本面板 UI）。
3. **真实 `fetch` 到 Host 路由未执行**：client 的 fetch 契约由 fake fetch 断言（URL/method/header/body/
   signal/响应映射）；真实同源请求、CSP `connect-src`、cookie/Peer 认证未运行。
4. **符号链接负例**：真实符号链接在本机因操作系统权限 `EPERM` 无法创建，用注入 fs adapter 证明代码分支；
   `symlinked parent` 同理用 adapter 验证 root realpath 偏离即拒绝。未在允许创建链接的环境复跑。
5. **文件 mode 0600**：Windows 不承载 POSIX mode，测试仅做 best-effort 检查（非 win32 才严格断言）；本机
   未验证权限位。
6. **真实会话/凭据/模型**：全部数据为合成 fixture；无真实会话内容、无凭据、无模型调用、无网络。
7. **出口证据层级**：`--network-evidence` 是 Node 进程内 API guard（monkeypatch `fetch`/`net`/`http`/`https`/
   `dns`），只算**覆盖 API 检测**；不等于 OS/Chromium/子进程级出口验证（设计 §8 已要求分层，不能把本项
   当作全进程零出口认证）。
8. **面板 locale 文案集合**：可见标签只使用 `locale/en.json`、`locale/zh.json` 现有 key。字段名
   （session_ref/context_ref/scope_id）与枚举值（stage、fidelity、category、certainty、reason code）以机器
   标识展示；若后续需要本地化这些标签，需要扩展 locale 目录（本任务写作用域不含 `locale/*`）。
9. **`context.list` 文档形状**：README 表写 `scope:{scope_id,generation}`，实际 `src/service.mjs` 经
   `access.listContexts` 返回扁平 `scope_id/generation`。client 两种都容忍（`normalizeContextEntry`），
   但 README/设计文本需要 Lead 同步其一。
10. **无构建步骤**：`client.js` 手工嵌入 `ui/` 两个模块（rc.5 client 产物无相对模块解析，仓库无打包工具）。
    `tests/client-contract.test.mjs` 逐字节校验嵌入副本与源文件一致，locale 字典与 `locale/*.json` 深比较，
    防止漂移；但这不是正式 bundle 构建链。
11. **Node 版本**：本机 Node 26.13.0 仅作补充验证，不构成 Node 24 兼容承诺（与 `docs/compatibility.md` 一致）。

## 7. 全仓快照（交叉参考，非本任务验收）

```powershell
node --test --test-isolation=none tests/
echo $LASTEXITCODE        # 0
# tests 175 / pass 175 / fail 0 / skipped 0（2026-11-07 快照，含其它任务与 Lead 的 transport/service 测试）
```

该快照仅说明同一时刻全仓测试同绿；T3 的验收仍以 §2、§3 两条命令为准。

## 8. 复现方式

```powershell
cd E:\dsh\plugin\07-context-management
node --test --test-isolation=none tests/export.test.mjs tests/client-contract.test.mjs
node tools/observe-smoke.mjs --fixture --network-evidence
node tools/context-report.mjs --fixture
node tools/context-report.mjs --session-ref session-x      # 预期 exit 3（拒绝直读）
```

测试/导出临时产物只写入 `$env:TEMP`（`mkdtemp` 与 `--out` 限制）；证据文件由文件工具写入本目录。
