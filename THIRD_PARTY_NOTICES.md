# Third-party notices / 来源说明

本项目 0.1.0 的交付代码为 07 能力自有实现，**未复制或打包任何上游插件源码**。
运行时依赖只有 DeepSeek Harness 自身提供的模块（peer/runtime 注入），本包不随附、不转售这些模块。

| 名称 | 版本/固定 | 许可 | 使用方式 | 是否随附代码 |
|---|---|---|---|---|
| DeepSeek Harness（`@deepseek-ai/*`） | 0.2.1-rc.5（本机已安装运行时；另 0.2.2-alpha.2 本地源码仅作只读参考） | MIT | 运行时/peer 依赖与 Host 接缝；只读核对安装字节并记录 SHA256 | 否 |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 调查固定树 `73fd9a5c29e593c28311f4760da5d0b1bba0dc49`（0.80.3）；本机 0.82.1 发布包仅行为对照 | Apache-2.0 | 仅借鉴“来源组成/估算展示/只读面板”机制；分类器、schema、面板、RPC 均为自行实现 | 否 |
| [dsh-context-manager](https://github.com/SkanderBog/dsh-context-manager) | 未固定 | 未确定 | 仅调查对照（观察与维护分离）；不引入依赖、不含其代码 | 否 |
| 05 本地记忆证据 | 本机 rc.5 安装字节逐字一致 | 本项目文档 | 只读引用 Session/LLM 边界证据 | 否 |

图标的 `icon.svg` 为本项目原创的简单几何图形，随本项目 MIT 许可发布。
若后续版本复用任何上游源码，必须先在本文件登记具体文件、许可、SHA256 与 NOTICE，再合入。
