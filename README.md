# 07 · 上下文观察与受控维护（只读首版实现）

状态：**只读观察已实现并自测；G0–G4 验收门禁已补齐（OS/Electron 级出口认证平台阻断、真实面板绑定读数未执行）；手动压缩（T5）按设计后置、未实现**。更新：2026-11-08。主形态为 DeepSeek Harness Host/client plugin；本目录同时是该插件仓库（`dsh-context-mng`）。

本插件在原生“上下文”面板里回答“这个会话目前保留了哪些内容、来源是什么、估算用量与 provider 实报各是多少”，并且**不修改**会话、prompt 或模型请求。观察、维护、05 长期记忆是三个独立概念；面板显示隐藏不代表模型遗忘。

实施路线、来源与边界见[实施路线](docs/implementation-route.md)；Host 兼容性以[兼容性说明](docs/compatibility.md)的实际字节为准；机制说明见[机制说明](docs/mechanisms.md)；验收门禁对照见[验收门禁补齐记录](docs/acceptance-gates.md)。

## 首版范围

已实现：

- 来源组成分类（system / developer / user / assistant / tools / tool_result / memory / unknown），未知保持 unknown，不从正文猜来源；
- 估算（`utf8_bytes_estimate_v1`，标签“UTF-8 字节估算”）与 provider 实报 usage 分列，不互相分摊；
- 有界内存观测快照（单会话 8 份 / 2MiB，总计 32MiB，LRU）、revision、去重、订阅与切会话失效；
- 只读采样：Session surface 投影、`llm/stream` 透明观测（不改 chunk、不缓存整条流）、`agent/pre-step` 只标阶段；
- 原生 client main 面板 + 只读 Connection RPC（`/local-context`）；
- 经授权的本地过滤报告导出（原子写、路径/符号链接防护、脱敏后内容）。

明确不做（首版）：自动压缩、自动 omit、维护写入、prompt 前后缀、Provider 切换、长期记忆写入、日志删除、跨会话搜索/聚合、成本账单、telemetry、网络出口。

## 配置（唯一授权来源）

`cordis.patch.yml` 的 `config.access.registry` 是唯一范围来源。必须显式登记才会采样/显示：

```yaml
- insert:
    - id: context-mng
      name: dsh-context-mng
      config:
        maintenance: { enabled: false }
        access:
          registry:
            schema_version: 1
            revision: 1
            bindings:
              - context_ref: my-project
                session_ref: session-1
                scope:
                  scope_id: my-project
                  generation: 1
                  identity_digest: "<64 位小写 hex>"
                read: true
                export_root_refs: [reports]
                active: true
            export_roots:
              - root_ref: reports
                path: "C:/Users/me/Documents/context-reports"
```

- `context_ref`/`session_ref` 是登记标识；`scope.identity_digest` 由登记方提供（任意稳定 64 hex），运行时不从正文/cwd 推断。
- `export_roots` 是 `export_root_refs` 到真实目录的内部映射；面板只看到 ref，不看到路径。
- 空 registry 是合法状态：面板显示“未登记/无权限”，不生成假数据。

## 浏览器传输（Host ↔ Client，本包自有合同）

实现期实测：rc.5 `connection.rpc.handle` 对 profile 插件不可用（详见[CTX-RPC-03 变更单](docs/design-change-ctx-rpc-03.md)）。
因此使用 rc.5 支持的 `connection.fetch.register` exact Fetch 路由；请求外壳与 BusinessResponse 语义不变，
响应体直接是 BusinessResponse（HTTP 200，业务拒绝也在 200 内），未认证 401、非 owner 403 由 Host 先行拒绝。

| endpoint | 路由 | data |
|---|---|---|
| `context.list` | `POST /api/context-mng/context.list` | `{contexts:[{context_ref,session_ref,scope_id,generation,read,export_root_refs}]}` |
| `observation.get` | `POST /api/context-mng/observation.get` | `{changed,observation?,current_revision}` |
| `group.read` | `POST /api/context-mng/group.read` | `{text,next_offset,revision}` |
| `report.export` | `POST /api/context-mng/report.export` | `{status:"saved"\|"conflict",report_ref,digest}` |

每个请求外壳：`{schema_version:1, operation_id, context_ref, expected_scope_generation, view_epoch, input}`；
`context.list` 使用同一外壳但不需要 context_ref/expected_scope_generation。请求体中的任何 caller/principal/grant
字段都会被严格 schema 拒绝；owner 门禁由 Host 在调用插件路由前完成，registry 是唯一的范围权威。

## 自测

```powershell
node --test --test-isolation=none tests/   # 178 组件/合同测试（Node 26；默认 node --test 在本机沙箱受 spawn 限制）
node tools/context-report.mjs --fixture    # 双合成会话只读报告
node tools/observe-smoke.mjs --fixture --network-evidence   # 缓存/切会话/取消/导出 + 出站 0
node tools/probe-host.mjs --asar "E:/dsh/resources/app.asar"  # rc.5 安装字节探针（28 checks）
```

门禁级验证（隔离 Host、真实 Chromium、真实已注册 Provider、安装/卸载、Node 24）见
[docs/acceptance-gates.md](docs/acceptance-gates.md) 与 `evidence/task5-*`；其中 OS/Electron 级包捕获出口认证
因当前会话未提权被平台阻断，真实面板绑定数据读数一致性未执行——均如实标注，不以组件测试替代。

## 安全边界

- 观察路径零网络、零子进程、零自动更新；正文不落盘（用户主动导出除外）。
- scope/正文先授权后读取；秘密过滤在投影与导出出口都执行。
- 不修改 prompt、不 append 会话、不取消主模型请求；`llm/stream` 包装透明 passthrough。
- 维护默认关闭；没有 Host 共享运行租约证据前不开启任何写路径。

## 开发入口

- [产品形态与首版范围](docs/product-form.md)：已确认方向、用户旅程与可修改设计默认。
- [编码级软件设计](docs/software-design.md)：首版只读观察、手动压缩后续增量；含 schema、Host 接缝、状态和需求变更地图。
- [实施路线与来源](docs/implementation-route.md)：开工说明、采用级别、隔离/出口边界与首个验收动作。
- [兼容性与已核接口](docs/compatibility.md)：rc.5 实际字节、哈希与接缝事实。
- [验收门禁补齐记录](docs/acceptance-gates.md)：G0–G5 对照、真实 AgentLoop/Chromium/Provider/安装卸载证据与阻断项。
- [机制说明](docs/mechanisms.md)：场景→触发→判断→状态→证据→失败恢复，供后续 skill 改进引用。
- [实现独立复审](docs/implementation-review.md)：无 Critical；2 Important/3 Minor 已修复并回归，列残余未验证层。
- [独立开发计划](PLAN.md)：分阶段任务索引与原始验收口径。
- [共同开发约束](../docs/development-contract.md)、[形态决策](../docs/capability-forms.md)、[详细设计](../docs/ecosystem-learning-design.md)。

## 许可

本项目代码 MIT（见 `LICENSE`）；来源与第三方说明见 `THIRD_PARTY_NOTICES.md`。本项目不随附 DeepSeek Harness 源码。
