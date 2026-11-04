# dsh-transcript-export

[![test](https://github.com/ruiyuxuanyan/dsh-transcript-export/actions/workflows/test.yml/badge.svg)](https://github.com/ruiyuxuanyan/dsh-transcript-export/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4c6ef5)](https://github.com/deepseek-ai/deepseek-harness)

[中文](README.md) · **English**

> Want to keep a conversation somewhere — or hand it to someone else?

You spend an hour working something out with Harness. The conclusion is in that last reply, but the commands that got you there, the errors, the files you read are scattered across dozens of collapsed blocks. Turning that into a document you can send to a colleague, drop into your notes, or still understand two months from now is not something `Ctrl+A` can do — it drags the runtime scaffolding, approval notices and raw tool JSON along for the ride. The official `dsh-session-log-export` hands you a zipped raw log and leaves the readable part to you.

That gap is what this plugin fills. One click on the reply you are reading, pick a format and a range, and it turns the conversation into a clean, self-contained document you would not be embarrassed to hand to a person.

<p align="center">
  <em>Pick a format → pick a range → decide about tool output and redaction → download, or keep a copy in the export library.</em>
</p>

## The tidying-up it does for you

- Scaffolding messages — runtime context, skill catalog, time sampling, model switches, approval notices — never reach the body. They are filtered **before** rendering, not scrubbed afterwards with regexes.
- Tool calls fold into one appendix, arguments and output each in their own block. A long output is truncated and then says, in plain words, how much it cut.
- Prose is rendered as real Markdown structure — headings, tables, lists, quotes, code blocks, inline styles — but it is **escaped first, structured second**, so any markup inside a transcript shows up as text.
- Reasoning is off by default. One checkbox if you want to see what it was thinking.
- Export from the reply you are reading back 1…N rounds, instead of always moving the whole conversation.
- Secrets get redacted on the way out, on by default, so you do not have to remember.

## Three formats, depending on where it is going

| Format | Good for |
| --- | --- |
| Markdown | Pasting into notes, a wiki, or repository docs. Diffs cleanly and stays easy to edit |
| HTML | Sending to a person. One self-contained file: inline styles, a table of contents, code highlighting, collapsible tool blocks. Opens offline by double-click, and hides the process when printed |
| JSON | Feeding a script. Ships `schemaVersion`, `generator` and an options snapshot |

The range is either the whole conversation or "last N rounds" (a slider from 1 to the total). Content flags cover tool calls, tool results, reasoning and timestamps. Redaction knows OpenAI, Anthropic, GitHub, GitLab, AWS, Slack, Google and Stripe keys, plus JWTs, Bearer/Basic headers, cookies, `password=` / `api_key=` assignments, credentialed DSNs and PEM private keys.

Nothing leaves the machine: the Host half renders and writes locally, the browser half only talks to it over same-origin `POST /dsh-session-share/*`, and then hands the bytes to a Blob download. The export library lives under `$DSH_HOME/exports` (default `~/.dsh/exports`), newest first, filterable, openable and deletable in place.

## Install

Three ways in — pick whichever suits you:

```bash
# from a local directory (best while you are editing the code)
dsh plugin --profile <profile> add /absolute/path/to/dsh-transcript-export

# from npm (once published)
dsh plugin --profile <profile> add dsh-transcript-export

# straight from GitHub, pinned to a commit (before npm has it)
dsh plugin --profile <profile> add 'git+https://github.com/ruiyuxuanyan/dsh-transcript-export.git#<sha>'
```

The plugin manager in the GUI works too, with the same spec (`install_bundle`). **Reload the page afterwards**: the icon row under each assistant reply gains a download button, right next to Copy and Branch.

### Getting into a plugin market

This repository ships its own **format 1 market index** (`market/index.json`, built by `npm run index`). Add the URL it is published at under **Settings → Plugins → Discover → Index sources** and the plugin becomes searchable and one-click installable, just like everyone else's.

The list the bundled market shows comes from the curated [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin): open a PR there with one line and the site and `dsh-market` pick it up automatically, usually within a day. Shipping your own index is the second path — for people who would rather add a source than depend on a catalog.

## Using it

1. Hover any assistant reply and click the **download** button in its action row.
2. In the dialog, choose a format, drag the turn-range slider, and decide about tool output, reasoning, timestamps and redaction.
3. **Export** downloads the file. With "also keep a copy" ticked, it is written into `$DSH_HOME/exports` as well. Saving never overwrites: a second export of the same name becomes `-2`, `-3`, and so on.
4. The **Export library** button (folder icon in the session header) lists everything you kept, newest first — filter it, open it right there, or delete it.

### Or let the agent do it

```
export this conversation as markdown, last 3 rounds, no tool results
```

The agent calls `export_session`, the file lands in `$DSH_HOME/exports`, and it tells you the path.

## Configuration

Override in the profile's `cordis.patch.yml`. `config` replaces the whole block, so restate every key you want:

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

- `lib/core.js` — the document model, three renderers, redaction and highlighting. **No imports, synchronous, no side effects**, so the Host, the browser and `node --test` all run the same code.
- `lib/index.js` — reads events through `sessionQuery.readSession(sessionId)` and normalizes them, mounts the `/dsh-session-share` prefix route on `webServer` (same-origin + loopback fence, 4 MB body cap, containment checks against directory traversal), and optionally registers `export_session`.
- `lib/client.js` — two slot entries; the dialog and the library are React built by hand from `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives` (no JSX, no build step).

## Security, taken seriously

- The route accepts only **same-origin, loopback** `POST`s: the `Host` header must be `127.0.0.1` / `localhost` / `[::1]`, and an `Origin` header must agree with it. Anything else is a 403.
- `read` / `delete` accept only paths **inside** the export folder; `../` and friends are refused.
- Every message, title and tool name is **escaped first, then structured**: Markdown only produces tags the renderer emits itself, so any HTML in a transcript shows up as text — same for table cells, code blocks and links, and links only accept `http(s)://`.
- Redaction is on by default and replaces matches with `[REDACTED]`. Turning it off is an explicit choice you have to make.

## Development

```bash
npm test        # node --test test/core.test.mjs test/host.test.mjs
npm run index   # regenerate market/index.json (pass --repo for the real repository URL)
```

- `test/core.test.mjs` covers normalization, redaction, all three renderers, HTML escaping, Markdown structure, nested fences and the helpers.
- `test/host.test.mjs` drives the real route through a miniature Cordis context: export, save, list, read back, delete, unique names on repeat saves, plus traversal, cross-origin and unknown-action refusals.
- `.github/workflows/test.yml` runs the same suite on Node 20 and 22 with nothing to install.

## Releasing

```bash
git remote add origin https://github.com/ruiyuxuanyan/dsh-transcript-export.git
git branch -M main && git push -u origin main
```

To be listed in the default market, add one line to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) under **Sessions & Messages**, in both `README.md` and `README.zh.md`, matching the neighbouring entries:

```markdown
- [ruiyuxuanyan/dsh-transcript-export](https://github.com/ruiyuxuanyan/dsh-transcript-export) - Export any conversation as clean Markdown, one self-contained HTML file, or JSON from the assistant action row, with turn ranges, Markdown-rendered prose, one folded command appendix per round, secret redaction and a searchable export library.
```

That list is compiled into a format 1 index (`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`) which `dsh-market` and the built-in Discover tab both read — so merging the PR is publishing.

## What it cannot do yet

- It exports the **text layer**: images you uploaded are listed by path rather than embedded (inlining base64 would turn a one-page HTML into megabytes).
- A whole-conversation export is not small — hundreds of KB of Markdown is normal. Pick "last N rounds" when the point is sharing.
- If the Host has never loaded the session, it falls back to the on-disk log. When neither is readable the export fails loudly instead of writing half a document.

## License

MIT

---

Something awkward, or a feature you want? Open an issue — it genuinely helps.