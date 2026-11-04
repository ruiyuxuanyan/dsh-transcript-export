# dsh-session-share

A **conversation export / share** plugin for DeepSeek Harness: turn any reply you are reading into a clean **Markdown**, **single-file HTML**, or **JSON** document.

<p align="center">
  <em>Pick a format → pick a range → turn tool output and redaction on or off → download, or keep a copy in the export library.</em>
</p>

## Why not "select all, copy"

`Ctrl+A` drags in runtime scaffolding, approval notices, raw tool JSON and whatever happens to be expanded; the official `dsh-session-log-export` gives you a **raw zipped log** and leaves the readable part to you. This plugin reads the same session log but writes a **document for humans**:

- scaffolding messages (runtime context, skill catalog, time sampling, model switches, approval notices) never reach the body — they are filtered **before** rendering, not scrubbed afterwards;
- tool calls collapse into `<details>`, arguments and output each get their own fenced block, and a truncated output **says how much it cut**;
- model reasoning is **off by default** and one checkbox away;
- export from **the reply you are reading** back 1…N rounds instead of the whole conversation;
- secrets are redacted by default.

## Features

| | |
| --- | --- |
| **Markdown** | `.md` — diffs cleanly, pastes into any editor, wiki or note app |
| **HTML** | `.html` — one self-contained file: inline styles, a table of contents, collapsible tool calls, code highlighting, zero external requests, readable offline, and tool blocks hidden when printed |
| **JSON** | `.json` — structured transcript with `schemaVersion`, `generator` and an options snapshot, for scripts and backups |
| **Range** | the whole conversation, or "last N rounds" (slider, 1…total) |
| **Content flags** | tool calls / tool results / reasoning / timestamps |
| **Redaction** | OpenAI, Anthropic, GitHub, GitLab, AWS, Slack, Google, Stripe keys, JWTs, Bearer/Basic headers, cookies, `password=` / `api_key=` assignments, credentialed DSNs, PEM private keys |
| **Export library** | saved under `$DSH_HOME/exports` (default `~/.dsh/exports`), listed newest first, filterable, openable, deletable |
| **Agent-facing** | an `export_session` tool, so "export this chat as Markdown" just works |

Nothing leaves the machine: the Host half renders and writes locally, and the browser half only talks to it over same-origin `POST /dsh-session-share/*` before handing the bytes to a Blob download.

## Install

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-session-share
```

Or install through the Harness plugin manager (`install_bundle` with the absolute package path). **Reload the page afterwards**: the icon row under each assistant reply (next to Copy and Branch) gains a download icon.

## Usage

1. Hover any assistant reply and click **Export / share** (the download icon) in its action row.
2. Choose the format, the range, which blocks to include, and whether to redact.
3. **Export** downloads the file; with "also keep a copy" it is written into `$DSH_HOME/exports` too.
4. The **Export library** button (folder icon, session header) lists, filters, opens and deletes everything kept there.

### Let the agent do it

```
export this conversation as markdown, last 3 rounds, no tool results
```
The agent calls `export_session`, the file lands in `$DSH_HOME/exports`, and it tells you the path.

## Configuration

Override in the profile's `cordis.patch.yml` (`config` replaces the whole block, so restate every key you want):

```yaml
- id: session-share
  config:
    exportDir: D:/notes/dsh-exports   # default: $DSH_HOME/exports
    exposeTool: true                  # register the export_session tool
    redactByDefault: true             # default of the redaction toggle
    language: zh                      # fixed section headings in exported documents
    theme: auto                       # HTML theme: auto | light | dark
```

## How it works

```
browser half (lib/client.js)                 host half (lib/index.js)
  conversation.chat.assistant-actions          webServer prefix route /dsh-session-share
    └ Export button → dialog                      ├ prepare   summary + redaction count
  conversation.session.header.actions             ├ export    render, optionally save
    └ Export library                             ├ list / read / delete
                                                  └ tools.register('export_session')
                     └──── same-origin POST ────┘
                                  ↓
                        lib/core.js (dependency-free, pure)
                        normalizeTranscript → renderMarkdown / renderHtml / renderJson
```

- `lib/core.js` — document model, three renderers, redaction, highlighting. **No imports, synchronous, side-effect free**, so the Host, the browser and `node --test` all run the same code.
- `lib/index.js` — reads events through `sessionQuery.readSession(sessionId)`, normalizes them, mounts the `/dsh-session-share` prefix route on `webServer` (same-origin + loopback fence, 4 MB body cap, containment checks), and optionally registers `export_session`.
- `lib/client.js` — two slot entries; the dialog and the library are React built by hand from `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives` (no JSX, no build step).

### Security

- The route accepts only **same-origin, loopback** `POST`s: the `Host` header must be `127.0.0.1` / `localhost` / `[::1]`, and an `Origin` header must agree with it. Anything else is a 403.
- `read` / `delete` accept only paths **inside** the export folder; `../` is refused.
- Every message, title and tool name is escaped in the HTML output; nothing in a transcript is parsed or executed.
- Redaction is on by default and replaces matches with `[REDACTED]`; turning it off is an explicit choice.

## Development

```bash
node --test test/core.test.mjs test/host.test.mjs
```

- `test/core.test.mjs` — normalization, redaction, all three renderers, HTML escaping, nested fences, helpers.
- `test/host.test.mjs` — drives the real route through a miniature Cordis context: export / save / list / read / delete, plus traversal, cross-origin and unknown-action refusals.

## Limitations

- The export is the **text layer**: user images are listed by path rather than embedded (inlining base64 would turn a one-page HTML into megabytes per file).
- Whole-conversation exports are large (hundreds of KB of Markdown is normal); pick "last N rounds" when sharing.
- If the Host has never loaded the session, `sessionQuery` falls back to the on-disk log; when neither is readable the export fails loudly instead of writing half a document.

## License

MIT
