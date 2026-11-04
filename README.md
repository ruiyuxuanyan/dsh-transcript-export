# dsh-session-share

DeepSeek Harness 的**会话导出 / 分享**插件：在任意一条助手回复的操作栏里，一键把这段对话导出成干净的 **Markdown**、**单文件 HTML** 或 **JSON**。

<p align="center">
  <em>选格式 → 选回溯轮数 → 勾掉工具输出 / 打开脱敏 → 下载或存进导出库。</em>
</p>

## 为什么不是"复制成文本"

`Ctrl+A` 复制会把运行时脚手架、审批提示、工具 JSON 和一堆折叠状态一起带走；官方 `dsh-session-log-export` 导的是**原始 zip 日志**，人能读的部分要自己挖。这个插件读同一条会话日志，但输出的是**给人看的文档**：

- 运行时上下文、技能目录、时间采样、模型切换、审批提示等脚手架消息**不进正文**（这在渲染前就过滤掉了，不是靠正则清理）；
- 工具调用折叠成 `<details>`，参数和输出各自一个围栏代码块，长输出截断并**明确标注**截了多少字符；
- 思考过程（reasoning）默认**不导出**，需要时一个勾选框；
- 可以直接从**你正在看的那条回复**往前回溯 1…N 轮，而不是整段对话；
- 顺手做**密钥脱敏**（默认开启）。

## 功能

| 能力 | 说明 |
| --- | --- |
| Markdown | `.md`，diff 友好，可直接粘进编辑器 / Wiki / 笔记 |
| HTML | `.html`，**单文件自包含**：内联样式、目录、可折叠工具调用、代码高亮，零外部请求，离线双击可用，打印时自动隐藏工具块 |
| JSON | `.json`，带 `schemaVersion` / `generator` / 选项快照的结构化记录，方便脚本二次处理 |
| 范围 | 整段对话，或"最近 N 轮"（1…总轮数滑杆） |
| 内容开关 | 工具调用 / 工具结果 / 思考过程 / 时间戳 |
| 脱敏 | OpenAI、Anthropic、GitHub、GitLab、AWS、Slack、Google、Stripe、JWT、Bearer/Basic、Cookie、`password=` / `api_key=` 赋值、带账号密码的 DSN、PEM 私钥 |
| 导出库 | 存在 `$DSH_HOME/exports`（默认 `~/.dsh/exports`），按时间列出，可筛选、浏览器内打开、删除 |
| 给 Agent 用 | 注册 `export_session` 工具，"把这段对话导出成 Markdown" 一句话就能落盘 |

导出**不经过任何网络**：Host 半边在本机渲染并写盘，浏览器半边只通过同源 `POST /dsh-session-share/*` 拿内容，然后 Blob 下载或存进导出库。

## 安装

```bash
# 从本地目录装（开发时最方便）
dsh plugin --profile <profile> add /absolute/path/to/dsh-session-share
```

在 Harness 图形界面里也可以用插件管理器安装：`install_bundle` + 上面的绝对路径。安装后**刷新页面**，助手回复下方那排图标（复制、分支旁边）会多出一个下载图标。

## 使用

1. 鼠标移到任意一条助手回复上，点那一排图标里的 **导出 / 分享**（下载图标）。
2. 弹窗里选格式、回溯范围、要不要工具输出 / 思考 / 时间戳、要不要脱敏。
3. **导出**：下载文件；勾了"同时留一份"就再写进 `$DSH_HOME/exports`。
4. 会话标题栏的 **导出库**（文件夹图标）列出所有留过档的导出，可筛选、打开、删除。

### 让 Agent 自己导出

```
把这个会话导出成 Markdown，只要最近 3 轮，不要工具结果
```
Agent 会调用 `export_session`，文件落在 `$DSH_HOME/exports`，并把路径告诉你。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（`config` 是整块替换，所以把要用的键一次写全）：

```yaml
- id: session-share
  config:
    exportDir: D:/notes/dsh-exports   # 默认 $DSH_HOME/exports
    exposeTool: true                  # 是否注册 export_session 工具
    redactByDefault: true             # 脱敏默认值
    language: zh                      # 导出文档里的固定标题（zh | en）
    theme: auto                       # HTML 主题 auto | light | dark
```

## 它怎么工作

```
浏览器半片 (lib/client.js)                   Host 半片 (lib/index.js)
  conversation.chat.assistant-actions          webServer 前缀路由 /dsh-session-share
    └ 导出按钮 → 弹窗                              ├ prepare  会话概要 + 脱敏计数
  conversation.session.header.actions            ├ export   渲染并可选落盘
    └ 导出库按钮                                 ├ list / read / delete
                                                 └ tools.register('export_session')
                     └──── 同源 POST JSON ────┘
                                  ↓
                        lib/core.js（无依赖、纯函数）
                        normalizeTranscript → renderMarkdown / renderHtml / renderJson
```

- `lib/core.js`：文档模型 + 三个渲染器 + 脱敏 + 高亮。**零依赖、同步、无副作用**，Host、浏览器和 `node --test` 里跑的是同一份代码。
- `lib/index.js`：读 `sessionQuery.readSession(sessionId)` 的会话事件，规范化成文档；`webServer` 上挂 `/dsh-session-share` 前缀路由（同源 + 回环校验、4 MB 请求上限、路径包含性校验防目录穿越）；可选注册 `export_session` 工具。
- `lib/client.js`：两个 Slot 入口，弹窗与导出库都是 React（`react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives` 三个模块，无 JSX、无构建步骤）。

### 安全

- 路由只接受 **同源 + 回环** 的 `POST`：`Host` 头必须是 `127.0.0.1` / `localhost` / `[::1]`，带 `Origin` 时必须与 `Host` 一致；其它来源一律 403。
- 导出库的 `read` / `delete` 只接受导出目录**内部**的路径，`../` 之类直接拒绝。
- HTML 输出中所有消息文本、标题、工具名都经过转义；不解析、不执行对话里的任何标记。
- 脱敏默认开启，替换成 `[REDACTED]`；关掉它需要你自己明确勾选。

## 开发

```bash
node --test test/core.test.mjs test/host.test.mjs
```

- `test/core.test.mjs` — 规范化、脱敏、三种渲染器、XSS 转义、围栏嵌套、helpers。
- `test/host.test.mjs` — 用一个迷你 Cordis 上下文驱动真实路由：导出 / 存盘 / 列出 / 读回 / 删除，以及目录穿越、跨源、未知 action 的拒绝。

## 已知限制

- 导出的是**文本层**：用户上传的图片以路径形式列出，不内嵌到 HTML 里（内嵌会让单文件变成几 MB 的 base64）。
- 长对话整段导出会比较大（几百 KB 的 Markdown 属正常）；想分享就选"最近 N 轮"。
- 会话没在 Host 上加载过时，`sessionQuery` 会回落到磁盘日志；两者都读不到时会明确报错，不会导出半截空文档。

## License

MIT
