# dsh-transcript-export

[![test](https://github.com/ruiyuxuanyan/dsh-transcript-export/actions/workflows/test.yml/badge.svg)](https://github.com/ruiyuxuanyan/dsh-transcript-export/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c6ef5)](https://github.com/deepseek-ai/deepseek-harness)

**中文** · [English](README.en.md)

> 想把一段对话留下来，或者发给别人看看？

你和 Harness 折腾了半天，结论落在最后那条回复里，可支撑它的命令、报错、翻过的文件，全都散在几十个折叠块中间。想把它变成一份能发给同事、能存进笔记、过两个月自己还看得懂的文档——`Ctrl+A` 复制帮不上忙，它会把运行时脚手架、审批提示、工具 JSON 一起搬走；官方的 `dsh-session-log-export` 导出的是原始 zip 日志，想要能读的文档还得自己挖一遍。

这个插件就是干这件事的：在你正在读的那条回复下面点一下，挑个格式、划个范围，它把这段对话整理成一份干净、自包含、可以直接拿给人看的文档。

<p align="center">
  <em>选格式 → 划回溯轮数 → 决定要不要工具输出、要不要脱敏 → 下载，或者先存进导出库。</em>
</p>

## 它替你收拾的那些活

- 脚手架消息——运行时上下文、技能目录、时间采样、模型切换、审批提示——不进正文。它们是在渲染前就被滤掉的，不是导出后再用正则擦一遍。
- 工具调用收进一个可折叠的附录，参数和输出各自成块；太长的输出会截断，并老实写清楚截了多少字符。
- 正文按 Markdown 渲染出真正的结构：标题、表格、列表、引用、代码块、行内样式。但**先转义、后套结构**，对话里出现的任何标记都只会当文字显示。
- 思考过程默认不导出。想知道它当时在想什么，勾一下就有。
- 可以只导"你正在看的这条回复往前 N 轮"，不必每次把整段对话搬走。
- 顺手把密钥抹掉，默认开着，不用你惦记。

## 三种格式，看你拿它干嘛

| 格式 | 适合 |
| --- | --- |
| Markdown | 想粘进笔记、Wiki、仓库文档。diff 友好，改起来不别扭 |
| HTML | 想直接发给人看。单文件自包含：样式、目录、代码高亮、可折叠的工具块全在里面，双击就能开，离线也行，打印时过程自动收起来 |
| JSON | 想让脚本接着处理。带 `schemaVersion`、`generator` 和选项快照 |

范围可以选整段对话，也可以选"最近 N 轮"（滑杆 1…总轮数）。内容开关管工具调用、工具结果、思考过程、时间戳。脱敏认得 OpenAI、Anthropic、GitHub、GitLab、AWS、Slack、Google、Stripe 的 key，也认 JWT、Bearer/Basic、Cookie、`password=` / `api_key=` 这类赋值、带账号密码的 DSN 和 PEM 私钥。

导出全程**不联网**：Host 那一半在本机渲染、写盘，浏览器那一半只通过同源 `POST /dsh-session-share/*` 取内容，然后 Blob 下载或存进导出库。导出库在 `$DSH_HOME/exports`（默认 `~/.dsh/exports`），按时间排着，能筛、能当场打开、能删。

## 安装

三条路，按你的情况挑一条：

```bash
# 从本地目录装 —— 改代码的时候最顺手
dsh plugin --profile <profile> add /absolute/path/to/dsh-transcript-export

# 从 npm 装（发布之后）
dsh plugin --profile <profile> add dsh-transcript-export

# 直接从 GitHub 装 —— 钉到某个提交，npm 上还没有时用
dsh plugin --profile <profile> add 'git+https://github.com/ruiyuxuanyan/dsh-transcript-export.git#<sha>'
```

图形界面的插件管理器也行，装法一样（`install_bundle` + 上面的 spec）。装完**刷新一下页面**，助手回复下面那排图标里会多一个下载按钮，就挨着复制和分支。

### 想让它出现在插件市场里

仓库自带一份 format 1 的索引（`market/index.json`，用 `npm run index` 生成）。在 **设置 → 插件 → 发现 → 索引源** 里把它发布后的 URL 加进去，你的插件就能像别人一样被搜到、被安装。

默认市场那份列表来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：去那边提个 PR 加一行，站点和 `dsh-market` 会自动收录，通常一天内生效。自带索引是给"不想依赖任何目录、只想加一个源"的人准备的第二条路。

## 用起来

1. 鼠标移到任意一条助手回复上，点那排图标里的**下载**按钮。
2. 弹窗里挑格式，拖一下回溯轮数，决定要不要工具输出、思考过程、时间戳，要不要脱敏。
3. 点**导出**就下载；勾了"同时留一份"，还会往 `$DSH_HOME/exports` 存一份。存盘不会覆盖旧的——同一个名字再导一次会变成 `-2`、`-3`。
4. 想看之前导出的，点会话标题栏的**导出库**（文件夹图标）就行。

### 也可以让 Agent 自己动手

```
把这个会话导出成 Markdown，只要最近 3 轮，不要工具结果
```

它会调 `export_session`，把文件写进 `$DSH_HOME/exports`，然后把路径告诉你。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖。`config` 是整块替换，所以要把用到的键一次写全：

```yaml
- id: session-share
  config:
    exportDir: D:/notes/dsh-exports   # 默认 $DSH_HOME/exports
    exposeTool: true                  # 是否注册 export_session 工具
    redactByDefault: true             # 脱敏默认值
    language: zh                      # 导出文档里的固定标题（zh | en）
    theme: auto                       # HTML 主题 auto | light | dark
```

## 它是怎么做到的

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

- `lib/core.js` —— 文档模型、三个渲染器、脱敏、高亮。**零依赖、同步、没有副作用**，Host 进程中、浏览器里和 `node --test` 下跑的是同一份代码。
- `lib/index.js` —— 读 `sessionQuery.readSession(sessionId)` 的会话事件，整理成文档；在 `webServer` 上挂 `/dsh-session-share` 前缀路由（同源 + 回环校验、4 MB 请求上限、路径包含性校验防目录穿越）；可选注册 `export_session` 工具。
- `lib/client.js` —— 两个 Slot 入口，弹窗和导出库都是 React 写的（只用 `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives` 三个模块，没有 JSX，也没有构建步骤）。

## 安全这件事，我们是当真的

- 路由只认**同源 + 回环**的 `POST`：`Host` 头必须是 `127.0.0.1` / `localhost` / `[::1]`，带 `Origin` 时必须和 `Host` 一致，其它来源一律 403。
- 导出库的 `read` / `delete` 只接受导出目录**里面**的路径，`../` 之类的直接拒绝。
- HTML 是**先转义、后套结构**：Markdown 只用来生成渲染器自己造的标签，对话里的 HTML 标记只会以文字出现——表格单元格、代码块、链接都一样，链接还只认 `http(s)://`。
- 脱敏默认开着，命中就换成 `[REDACTED]`；想关得你自己明确勾掉。

## 开发

```bash
npm test        # node --test test/core.test.mjs test/host.test.mjs
npm run index   # 生成 market/index.json（用 --repo 指向最终仓库地址）
```

- `test/core.test.mjs` 管规范化、脱敏、三个渲染器、XSS 转义、Markdown 结构、围栏嵌套和一堆 helper。
- `test/host.test.mjs` 用一个迷你 Cordis 上下文驱动真实路由：导出、存盘、列出、读回、删除，外加目录穿越、跨源和未知 action 的拒绝。
- `.github/workflows/test.yml` 在 Node 20 / 22 上跑同一套测试，零依赖安装。

## 发布

```bash
git remote add origin https://github.com/ruiyuxuanyan/dsh-transcript-export.git
git branch -M main && git push -u origin main
```

想被默认市场收录，去 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `README.md` 和 `README.zh.md` 里，**Sessions & Messages** 分类各加一行（英文行、中文行，格式跟着邻居写）：

```markdown
- [ruiyuxuanyan/dsh-transcript-export](https://github.com/ruiyuxuanyan/dsh-transcript-export) - Export any conversation as clean Markdown, one self-contained HTML file, or JSON from the assistant action row, with turn ranges, Markdown-rendered prose, one folded command appendix per round, secret redaction and a searchable export library.
```

那份列表会被合成为 format 1 索引（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`），`dsh-market` 和内置发现页读的是同一份文档——所以合并进去，基本就等于上架了。

## 它现在还做不到的

- 只导出**文本层**：你上传的图片以路径列出来，不会内嵌进 HTML（内嵌会让单文件变成好几 MB 的 base64）。
- 长对话整段导出会不小，几百 KB 的 Markdown 属正常；只是分享的话，选"最近 N 轮"更合适。
- 会话从没在 Host 上加载过时，会回落到磁盘日志；两边都读不到就明确报错，不会给你一份半截的空文档。

## License

MIT

---

用着别扭的地方、想要的功能，欢迎开个 issue 说一声。