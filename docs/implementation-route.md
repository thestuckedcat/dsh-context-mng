# 07 实施路线（开工说明）

版本：CTX-ROUTE-1；日期：2026-11-07；状态：已开工（只读首版）。依据：[软件设计 CTX-DESIGN-2](software-design.md)、[产品形态 CTX-PF-1](product-form.md)、根[实施说明](../../AGENTS.md)、[共同开发约束](../../docs/development-contract.md)、[安装测试计划](../../docs/live-installation-plan.md)。

## 1. 本次范围与首版交付

按用户已确认的 CTX-PF-01（首版只读观察、手动压缩后续增量）实施 **T1—T4 + T6 的只读首版**：

- T1 投影/来源分类/估算/实报/过滤/词表外不猜（CTX-01、02 的纯核心部分）；
- T2 rc.5 真实 Session/LLM 接缝与只读采样（CTX-03）；
- T3 有界观测缓存、受控导出、原生 client 面板与 CLI 后备（CTX-04、05）；
- T4 出口/隔离验收中可执行的部分；完整 Loader/Chromium 用户旅程按证据分级如实记录缺口（CTX-06）；
- T6 完成时机制说明（`docs/mechanisms.md`）。

**不做**：T5 受控维护（设计明确为后置、`maintenance enable=false`）、prompt 前后缀、自动压缩、长期记忆、日志删除、跨会话搜索、Provider 切换。等 Host 运行租约与写路径证据齐备后另起增量。

首个可验交付：两个合成会话的只读投影报告，证明 A 读不到 B、估算/实报/未知不混淆、观察不改消息。之后是 rc.5 隔离宿主的面板/RPC 可加载性；完整 GUI  journeys 单列未验证。

## 2. 来源与采用方式（固定身份）

| 来源 | 固定身份 | 提供的机制 | 采用方式 |
|---|---|---|---|
| 本机已安装 DSH | `0.2.1-rc.5`（`E:\dsh\resources\app.asar\dsh\package.json` 只读确认）；Electron 44.7.0；app.asar 只读解析 | Cordis 生命周期、Session `deriveMessages()`/`session/event`、`llm/stream` waterfall、`agent/pre-step`、Connection RPC（`rpc.handle`/`rpc.call`）、原生 `slots`/`layout` main panel | **薄适配**：只在 `src/host-rc5.mjs`、`index.js`、`client.js` 绑定真实 API；不复制 Host 源码。关键文件 SHA256 已与设计表一致（见 `docs/compatibility.md`） |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 调查固定树 `73fd9a5c29e593c28311f4760da5d0b1bba0dc49` 0.80.3（Apache-2.0）；本机另有无源码发布包 0.82.1 仅作**行为对照** | 来源组成/演进/估算展示的机制；只读面板组织方式 | **只借鉴机制**，不复制其源码或 bundle；本项目按自有 schema/分类器/面板自行实现，未合入任何上游文件 |
| [dsh-context-manager](https://github.com/SkanderBog/dsh-context-manager) | 无固定构件/许可证据 | 预览/omit/压缩与观察分离的对照 | **仅调查对照**，不引入依赖；首版不实现维护 |
| 05 本地记忆证据 | 05 `evidence/host-api` 与 rc.5 安装字节逐字一致（`dsh-session/lib/index.js` SHA256 `2f5dd07c…`） | Session/LLM 边界与 Provider 结果语义 | **引用本机只读证据**；不继承 05 业务授权为 07 任意路由授权 |

不存在的复用：未下载/安装任何上游发布包作为运行依赖；未把 0.2.2-alpha.2 源码当现用 Host。

## 3. 实施顺序与证据层级

1. 固定构件探针：从已安装 app.asar 只读解析 rc.5 包字节，记录 SHA256（`tools/probe-host.mjs` 的 evidence）。
2. 纯投影与 scope 过滤（T1）：失败用例先行 → 最小实现 → 通过。
3. rc.5 只读 Host 观察（T2）：真实 `dsh-session`/`dsh-llm` 字节上跑 derive/waterfall 透明性探针；fake adapter 只替代模型网络。
4. 有界缓存、导出与原生 client 面板（T3）：组件/合同测试 + 隔离宿主可加载性。
5. 出口与隔离（T4）：静态出口审计 + 运行期网络调用断言；完整 Chromium 面板旅程不作为首版通过条件，如实标未验证。
6. 机制说明与独立自查（T6）。

证据分层始终分开记录：组件/合同 → 实际安装库（rc.5 字节） → 隔离完整 Host → 真实 GUI/出口。低层通过不自动升级为高层通过。

## 4. 隔离、状态与出口边界

- **身份**：`caller` 只由 Host 真实 `peer.principal` 闭包注入；首版仅 `kind==='owner'`，不读 payload 中的 caller/grant。`ContextAccessRegistryV1` 是唯一范围来源，绑定由用户配置显式登记，不从模型输出、日志正文、cwd 或前端路由临时登记。
- **状态**：观察正文不落盘；重启为空；导出例外且经脱敏。缓存有界（单会话 2MiB/8 份，总 32MiB，LRU），切会话/撤权/卸载清正文与监听。
- **只读**：不修改 prompt、不 append 会话、不取消主模型请求；`llm/stream` 包一层透明 AsyncIterable，原 chunk 逐项原样 yield；采样失败只丢本插件观察。
- **出口**：观察路径无网络、无子进程、无自动更新/下载；UI 仅走 Host 授权的 connection RPC；面板不读磁盘；导出限制在登记根内并防路径穿越/符号链接。
- **本地工程限制**：实现期使用工作区内隔离目录 `.work07/` 放 rc.5 只读抽取与临时产物，不进入仓库、不修改 `~/.dsh` 现有 profile；本轮不向当前运行的 Harness profile 安装，隔离宿主验证独立进行。本机运行时为 Node 26.13.0（设计基线 Node 24；差异记录在 `docs/compatibility.md`，不作为兼容承诺）。

## 5. 首个验收动作

`tests/access.test.mjs` + `tests/projection.test.mjs`：先写失败用例——A scope 读 B 被拒、未知来源不猜、provider usage 不摊到组、假秘密不出现在投影/导出、超限标 truncated、图片模态保持未知；再实现并使 `node --test` 通过。随后才进入 rc.5 真实库探针。

## 6. 交付仓库

实现随本目录提交并同步到用户指定仓库 `https://github.com/thestuckedcat/dsh-context-mng.git`。不会把 rc.5 抽取物、Host 源码副本、凭据或真实会话内容提交进仓库。
