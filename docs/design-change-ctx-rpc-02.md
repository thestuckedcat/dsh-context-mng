# 设计变更单 CTX-RPC-02：实现期补正（context.list 与 RpcResult 落地）

版本：CTX-CHANGE-1；日期：2026-11-07；状态：已实现并自测；隔离宿主加载/认证/RPC 已由 CTX-RPC-03 传输实测覆盖，下文第 2 节的 RpcResult 外壳随传输替换不再使用（业务响应语义保留）；影响 ID：CTX-02、CTX-04、CTX-06。

## 1. 背景

CTX-DESIGN-2 §5.1 定义了三个业务端点（`observation.get`、`group.read`、`report.export`），并要求每个请求都携带 `context_ref` 与 `expected_scope_generation`，registry 是唯一授权来源。实现时发现一个可编码性缺口：

- 浏览器 Client 打开面板时需要知道“当前主会话对应哪个已登记 `context_ref`”，但设计中没有任何只读入口可以向 owner 提供这个映射；
- `context_ref` 又不能由前端/模型/cwd 自行推导（那会绕过 registry）。

rc.5 也没有现成的项目 scope 服务（`dsh-scope` 是注册作用域原语，不是项目身份；`Session.header` 无项目 scope 字段）。因此不补一个受限的发现入口，首版 UI 无法在不自授范围的前提下工作。

## 2. 变更内容

新增 **owner-only 只读端点 `context.list`**：

- 请求不需要 `context_ref`/`expected_scope_generation`：`{schema_version:1, operation_id, view_epoch, input:{}}`，严格拒绝其他字段；
- 返回仅包含**登记且 active** 的绑定摘要：`{contexts:[{context_ref, session_ref, scope_id, generation, read, export_root_refs}]}`；
- 不返回绝对导出路径、不返回会话正文、不返回任何未登记会话；
- 仍然要求真实 Host peer 的 `principal.kind === "owner"`；浏览器共享 owner Peer 不构成额外枚举能力，列表本身就是该 owner 已登记范围。

其余端点保持 CTX-DESIGN-2 的四字段请求外壳与业务响应 union 不变。RPC 落地遵循已核 rc.5 字节：

- 处理器返回值是 `RpcResult`（`{ok:true, value:BusinessResponse}`），不是裸 BusinessResponse；
- 插件 catch 全部异常并生成固定 `INTERNAL_FAILURE` 业务响应，绝不把原 Error 交给 Host 默认 500 路径；
- Client 先检查 `result.ok`，再校验 `BusinessResponse`，传输失败映射为固定 `TRANSPORT_FAILURE`，不展示原 message/details，不自动重发写操作。

## 3. 内部形状补正（不改变安全语义）

- `ContextAccessRegistryV1` 增加顶层 `export_roots: [{root_ref, path}]`，把设计中的 `export_root_refs` 引用解析到真实目录。`context.list` 只暴露 `root_ref`，路径始终留在 Host 侧。
- `boundary.last_event_seq` 明确为“已接受事件数（下一 seq）”，空会话为 0；避免空会话用负数违反“计数非负安全整数”。
- Client 判定“当前主会话”只使用 rc.5 已存在的只读选择器（`ctx.sessions.list` 中 `retainedBy.mainView > 0` 的会话），仅用于选择已登记绑定，不构成授权。

## 4. 影响与回归

- CTX-02（先 scope 后正文）：新增端点在授权前只返回登记摘要，不读正文；`tests/access.test.mjs`、`tests/rpc.test.mjs` 覆盖伪造 caller/额外字段/未知 context。
- CTX-04（切换/订阅/大输出）：Client 用 `context.list` 做一次 bootstrap，之后按 `observation.get` 轮询；切会话递增 view epoch 并丢弃旧响应。
- CTX-06（Host 精确兼容/无旁路）：不新增网络出口；只调用 rc.5 Connection RPC 已核接口。
- 未关闭缺口：真实 Chromium 页面中 `context.list` 的实际加载与展示仍未执行，证据中单列未验证。

## 5. 回退

删除 `context.list` 与 Client bootstrap 后，UI 需退化为“用户手工输入 context_ref”模式；Host 其余端点与安全边界不受影响。设计原文 CTX-DESIGN-2 的请求/响应合同保持有效。
