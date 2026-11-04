/**
 * dsh-transcript-export — Host half.
 *
 * Responsibilities, and nothing else:
 *  1. read one session's event log through the Host `sessionQuery` service;
 *  2. turn it into the export document with the shared core;
 *  3. optionally write the rendered file into the export folder;
 *  4. serve all of that to the browser half over a loopback-only
 *     `POST /dsh-transcript-export` route (same-origin fence, like the rest of
 *     the plugin ecosystem's Host↔Client bridges).
 *
 * The agent-facing `export_session` tool is registered on request: an agent
 * that is asked "把这段对话导出成 Markdown" can answer without the user
 * clicking anything.
 *
 * @module dsh-transcript-export
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  byteLength,
  countRounds,
  formatBytes,
  normalizeTranscript,
  renderDocument,
  sliceTurns,
  slugify,
} from './core.js'

/** Cordis plugin name. */
export const name = 'session-share'

/**
 * Cordis injection. `inject` here lists the services other plugins must have
 * loaded before this one starts; it is not a per-service optionality map, and
 * unknown names simply never resolve (the plugin would stay pending forever).
 * The export route waits for `webServer` through `ctx.inject([...])` below, so
 * a deployment without it still gets the agent tool and vice versa.
 */
export const inject = []

/** Route prefix; the exact endpoint is `POST <prefix>/export` & friends. */
const ROUTE = '/dsh-transcript-export'

/** Upper bound on one chatty request body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Largest single exported file the library will read back for download. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

/**
 * Where saved exports live. DSH_HOME keeps exports beside the sessions they
 * came from; without it, the platform home directory is the fallback.
 * @returns {string}
 */
export function defaultExportDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'exports')
}

/**
 * Apply the plugin's config, tolerating both a plain object and a resolved
 * schemastery config.
 * @param {Record<string, unknown>} [config]
 */
export function resolveConfig(config = {}) {
  const record = config && typeof config === 'object' ? config : {}
  const dir = typeof record.exportDir === 'string' && record.exportDir.trim() !== '' ? record.exportDir.trim() : defaultExportDir()
  return {
    exportDir: resolve(dir),
    exposeTool: record.exposeTool !== false,
    redactByDefault: record.redactByDefault !== false,
    language: record.language === 'en' ? 'en' : 'zh',
    theme: record.theme === 'light' || record.theme === 'dark' ? record.theme : 'auto',
  }
}

/**
 * Host half of the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  /**
   * Read and normalize one session. Falls back from the Host's live-preferred
   * query service to the in-memory store when the query service is absent.
   * @param {string} sessionId
   * @param {{ redact?: boolean }} [options]
   */
  async function readTranscript(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('a session id is required')
    const query = ctx.get('sessionQuery')
    let events = []
    let title
    let model
    let cwd
    let createdAt

    if (query !== undefined && typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      events = snapshot.events ?? []
      title = typeof snapshot.session?.title === 'string' ? snapshot.session.title : undefined
      cwd = typeof snapshot.session?.cwd === 'string' ? snapshot.session.cwd : undefined
      createdAt = typeof snapshot.session?.createdAt === 'number' ? snapshot.session.createdAt : undefined
      try {
        const titleSnapshot = typeof query.readTitleSnapshot === 'function' ? await query.readTitleSnapshot(sessionId) : undefined
        if (titleSnapshot?.title?.title) title = titleSnapshot.title.title
      } catch {
        // A missing title is not an export failure: the log carries one too.
      }
    } else {
      const sessions = ctx.get('sessions')
      const live = sessions?.get?.(sessionId)
      if (live === undefined) throw new Error(`session "${sessionId}" is not available on this Host`)
      events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents(0) : (live.log ?? [])
      cwd = live.header?.cwd
      createdAt = live.header?.createdAt
    }

    for (const event of events) {
      if (event?.type === 'model/selection' && typeof event.data?.model === 'string') model = event.data.model
      if (event?.type === 'request/header' && typeof event.data?.model === 'string') model = event.data.model
    }

    const { doc, redactions } = normalizeTranscript(
      { sessionId, events },
      {
        title,
        model,
        cwd,
        redact: options.redact ?? settings.redactByDefault,
        now: Date.now(),
      },
    )
    return { doc, redactions, createdAt }
  }

  /**
   * Compose the file name for one export.
   * @param {import('./core.js').Transcript} doc
   * @param {string} sessionId
   * @param {string} extension
   */
  function exportFileName(doc, sessionId, extension) {
    const date = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    const base = slugify(doc.session.title === 'Conversation' ? sessionId : doc.session.title, 'conversation')
    return `${base}-${stamp}.${extension}`
  }

  /**
   * Refuse paths that escape the export folder — the library endpoints take
   * a caller-supplied name, so containment is checked, not assumed.
   * @param {string} requested
   */
  function containedPath(requested) {
    const absolute = resolve(settings.exportDir, requested)
    const rel = relative(settings.exportDir, absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error('the path is outside the export folder')
    }
    return absolute
  }

  /**
   * Write one rendered document to disk.
   * @param {{ content: string, extension: string }} rendered
   * @param {import('./core.js').Transcript} doc
   * @param {string} sessionId
   * @param {string} requestedName
   */
  async function saveExport(rendered, doc, sessionId, requestedName) {
    await mkdir(settings.exportDir, { recursive: true })
    const safeRequested =
      typeof requestedName === 'string' && requestedName.trim() !== '' ? basename(requestedName.trim()) : undefined
    const fileName = await freeName(safeRequested ?? exportFileName(doc, sessionId, rendered.extension))
    const absolute = containedPath(fileName)
    await writeFile(absolute, rendered.content, 'utf8')
    return { name: basename(absolute), path: absolute, bytes: byteLength(rendered.content) }
  }

  /**
   * Never overwrite an earlier export. The library is an archive: a second
   * export of the same conversation, or a name the caller reused, gets `-2`,
   * `-3`, … instead of replacing what is already there.
   * @param {string} fileName
   */
  async function freeName(fileName) {
    const extension = extname(fileName)
    const stem = basename(fileName, extension)
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const candidate = attempt === 1 ? fileName : `${stem}-${String(attempt)}${extension}`
      try {
        await stat(containedPath(candidate))
      } catch (error) {
        // A name outside the folder is not "free" — let containedPath's
        // rejection reach the caller instead of writing somewhere untracked.
        if (error?.code === 'ENOENT') return candidate
        throw error
      }
    }
    return `${stem}-${String(Date.now())}${extension}`
  }

  /** One export request, end to end. */
  async function exportSession(args = {}) {
    const sessionId = String(args.sessionId ?? '')
    const format = args.format === 'html' || args.format === 'json' ? args.format : 'markdown'
    const { doc, redactions } = await readTranscript(sessionId, {
      redact: args.redact === undefined ? settings.redactByDefault : args.redact !== false,
    })
    const ranged = sliceTurns(doc, Number.isFinite(args.turns) ? Number(args.turns) : undefined)
    const rendered = renderDocument(ranged, format, {
      language: args.language === 'en' || args.language === 'zh' ? args.language : settings.language,
      toolCalls: args.toolCalls,
      toolResults: args.toolResults,
      reasoning: args.reasoning,
      timestamps: args.timestamps,
      theme: args.theme === 'light' || args.theme === 'dark' ? args.theme : settings.theme,
      redactions,
    })
    const saved = args.save === true ? await saveExport(rendered, ranged, sessionId, args.name) : undefined
    return {
      ok: true,
      sessionId,
      format,
      title: ranged.session.title,
      rounds: countRounds(ranged),
      messages: ranged.messages.length,
      redactions,
      bytes: byteLength(rendered.content),
      content: rendered.content,
      extension: rendered.extension,
      contentType: args.save === true ? 'text/plain; charset=utf-8' : undefined,
      saved,
    }
  }

  /** List the export folder. */
  async function listExports() {
    await mkdir(settings.exportDir, { recursive: true })
    const entries = await readdir(settings.exportDir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      if (!/\.(md|html|json)$/i.test(entry.name)) continue
      const absolute = join(settings.exportDir, entry.name)
      try {
        const info = await stat(absolute)
        files.push({
          name: entry.name,
          path: absolute,
          bytes: info.size,
          size: formatBytes(info.size),
          createdAt: info.birthtimeMs || info.mtimeMs,
        })
      } catch {
        // A file that vanished between readdir and stat is simply not listed.
      }
    }
    files.sort((a, b) => b.createdAt - a.createdAt)
    return { dir: settings.exportDir, files }
  }

  /** Read one saved export back for the browser's download button. */
  async function readExport(requestedName) {
    const absolute = containedPath(String(requestedName ?? ''))
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error('not a file')
    if (info.size > MAX_DOWNLOAD_BYTES) throw new Error('the file is too large to download from the browser; open it from the export folder')
    return { name: basename(absolute), path: absolute, content: await readFile(absolute, 'utf8') }
  }

  /** Delete one saved export. */
  async function deleteExport(requestedName) {
    const absolute = containedPath(String(requestedName ?? ''))
    await unlink(absolute)
    return { name: basename(absolute), path: absolute }
  }

  /**
   * The method table the route dispatches on. A function value receives the
   * decoded JSON argument.
   */
  const methods = {
    ping: () => ({ ok: true, exportDir: settings.exportDir, language: settings.language }),
    describe: () => ({
      ok: true,
      exportDir: settings.exportDir,
      redactByDefault: settings.redactByDefault,
      language: settings.language,
      theme: settings.theme,
    }),
    prepare: (args) => prepareSession(args),
    export: (args) => exportSession(args),
    list: async () => ({ ok: true, ...(await listExports()) }),
    read: async (args) => ({ ok: true, ...(await readExport(args?.name)) }),
    delete: async (args) => ({ ok: true, ...(await deleteExport(args?.name)) }),
  }

  /** A lightweight stat used by the dialog's live summary. */
  async function prepareSession(args = {}) {
    const sessionId = String(args.sessionId ?? '')
    const { doc, redactions } = await readTranscript(sessionId, {
      redact: args.redact === undefined ? settings.redactByDefault : args.redact !== false,
    })
    const ranged = sliceTurns(doc, Number.isFinite(args.turns) ? Number(args.turns) : undefined)
    const rendered = renderDocument(ranged, args.format === 'html' || args.format === 'json' ? args.format : 'markdown', {
      language: settings.language,
      toolCalls: args.toolCalls,
      toolResults: args.toolResults,
      reasoning: args.reasoning,
      timestamps: args.timestamps,
      redactions,
    })
    return {
      ok: true,
      sessionId,
      title: ranged.session.title,
      model: ranged.session.model,
      rounds: countRounds(ranged),
      totalRounds: countRounds(doc),
      messages: ranged.messages.length,
      totalMessages: doc.messages.length,
      redactions,
      bytes: byteLength(rendered.content),
      size: formatBytes(byteLength(rendered.content)),
      exportDir: settings.exportDir,
    }
  }

  // #region HTTP route

  /**
   * Same-origin fence. The Host GUI is a loopback page; a request that did not
   * originate from it (another tab's fetch, a plain process, a rebound DNS
   * name) must not be able to read a session log.
   * @param {import('node:http').IncomingMessage} req
   */
  function sameOrigin(req) {
    const hostHeader = String(req.headers.host ?? '')
    const authority = hostHeader.replace(/^(.*[^:]):\d+$/, '$1')
    const loopback =
      authority === '127.0.0.1' || authority === 'localhost' || authority === '[::1]' || authority === '::1' || authority === '0.0.0.0'
    // A reverse proxy serving the GUI forwards its own public authority; the
    // Host header then is not loopback, so only the origin/host agreement is
    // checked and the deployment's own auth stands in front.
    const origin = req.headers.origin ? String(req.headers.origin) : ''
    const sameHost = origin === `http://${hostHeader}` || origin === `https://${hostHeader}`
    if (!loopback && !sameHost) return false
    if (origin !== '' && !sameHost) return false
    return true
  }

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
  function reply(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  ctx.inject(['webServer'], (web) => {
    web.effect(
      () =>
        web.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: async (req, res) => {
            if (!sameOrigin(req)) {
              reply(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'POST') {
              reply(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const method = new URL(req.url ?? '/', 'http://x').pathname.slice(ROUTE.length + 1)
            const action = Object.hasOwn(methods, method) ? methods[/** @type {keyof typeof methods} */ (method)] : undefined
            if (typeof action !== 'function') {
              reply(res, 404, { ok: false, error: `unknown action "${method}"` })
              return
            }
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > MAX_BODY_BYTES) {
                reply(res, 413, { ok: false, error: 'request body too large' })
                return
              }
              chunks.push(chunk)
            }
            let args = {}
            if (size > 0) {
              try {
                args = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch {
                reply(res, 400, { ok: false, error: 'the request body is not JSON' })
                return
              }
            }
            try {
              reply(res, 200, await action(args))
            } catch (error) {
              reply(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'session-share: export route',
    )
  })

  // #endregion
  // #region agent tool

  if (settings.exposeTool) {
    ctx.inject(['tools'], (toolCtx) => {
      const output = {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            name: { type: 'string' },
            bytes: { type: 'number' },
            rounds: { type: 'number' },
            messages: { type: 'number' },
            redactions: { type: 'number' },
          },
          additionalProperties: false,
        },
        render: (args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `Exported ${value.messages} messages (${value.rounds} rounds) to ${value.path} (${formatBytes(value.bytes)}).` +
                (value.redactions > 0 ? ` ${value.redactions} secret(s) redacted.` : '')
              : `Export failed: ${value.error ?? 'unknown error'}`,
          },
        ],
      }

      toolCtx.effect(
        () =>
          toolCtx.tools.register({
            name: 'export_session',
            description:
              'Export a DeepSeek Harness conversation to a file the user can share: Markdown (default), a self-contained HTML page, or JSON. ' +
              'Use it when the user asks to export, save, archive or share the current chat or part of it. ' +
              'The transcript is read from the session log; tool results can be trimmed, model reasoning is opt-in, and credentials are redacted by default.',
            parameters: {
              session_id: {
                type: 'string',
                required: true,
                description: 'Session id to export. For the current conversation use the id in the runtime context.',
              },
              format: {
                type: 'string',
                enum: ['markdown', 'html', 'json'],
                description: 'Output format: "markdown" (default), "html", or "json".',
              },
              turns: {
                type: 'number',
                description: 'Keep only the last N rounds (one user message plus its reply). Omit for the whole conversation.',
              },
              include_tool_calls: { type: 'boolean', description: 'Include tool calls (default true).' },
              include_tool_results: { type: 'boolean', description: 'Include tool output (default true).' },
              include_reasoning: { type: 'boolean', description: 'Include the model reasoning blocks (default false).' },
              redact_secrets: {
                type: 'boolean',
                description: 'Redact API keys, tokens, passwords and private keys (default true). Turn it off only when the user explicitly asks for an unredacted copy.',
              },
              file_name: {
                type: 'string',
                description: 'Optional file name to write inside the export folder. Omit to use a title- and time-based name.',
              },
            },
            output,
            isConcurrencySafe: () => true,
            async execute(args) {
              const result = await exportSession({
                sessionId: args.session_id,
                format: args.format,
                turns: args.turns,
                toolCalls: args.include_tool_calls,
                toolResults: args.include_tool_results,
                reasoning: args.include_reasoning,
                redact: args.redact_secrets,
                name: args.file_name,
                save: true,
              })
              return {
                ok: true,
                path: result.saved?.path ?? '',
                name: result.saved?.name ?? '',
                bytes: result.bytes,
                rounds: result.rounds,
                messages: result.messages,
                redactions: result.redactions,
              }
            },
          }),
        'session-share: export_session tool',
      )
    })
  }

  // #endregion
  // #region prompt note

  // The tool description is the agent's contract; the system-prompt note only
  // tells it where exports land, which the description cannot say (the folder
  // is deployment configuration). `section()` returns its own disposer, so the
  // effect callback returns it directly.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => {
      const prompt = promptCtx.get('systemPrompt')
      if (typeof prompt?.section !== 'function') return
      return prompt.section({
        name: 'session-share:exports',
        order: 5,
        text: `Conversation exports (the export_session tool) are written to ${settings.exportDir}. Mention that path when you export something, so the user can find the file.`,
      })
    }, 'session-share: export folder note')
  })

  // #endregion
}

export default { name, inject, apply, defaultExportDir, resolveConfig }
