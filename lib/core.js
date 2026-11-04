/**
 * Conversation export core — pure, dependency-free.
 *
 * The transcript is a *document model* (sessions → rounds → messages →
 * blocks) produced by {@link normalizeTranscript} from a session event log.
 * Three renderers turn that document into Markdown, a self-contained HTML
 * page, or JSON. Everything in this module is synchronous, side-effect free
 * and has no imports, so it runs the same in the Host process, in the
 * browser, and under `node --test`.
 *
 * @module dsh-session-share/core
 */

/** Bump when the normalized document or the JSON envelope changes shape. */
export const SCHEMA_VERSION = 1

/** Placeholder that replaces a detected secret. */
export const REDACTED = '[REDACTED]'

// #region text helpers

const TEXT_EXT = /\.(md|markdown|txt|log|csv|tsv|json|jsonl|yaml|yml|toml|ini|cfg|conf|env|xml|html|htm|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|swift|sh|bash|zsh|ps1|bat|sql|svg|lua|r|dart|ex|exs|vue|svelte)$/i

/**
 * Whether a file path is worth inlining as text when it appears in a
 * tool result or a delivered file.
 * @param {string} path
 * @returns {boolean}
 */
export function looksLikeTextPath(path) {
  return typeof path === 'string' && TEXT_EXT.test(path.trim())
}

/**
 * Read a value as display text: strings pass through, content blocks join
 * their text parts, anything else is JSON.
 * @param {unknown} value
 * @returns {string}
 */
export function toText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => (item && typeof item === 'object' && typeof item.text === 'string' ? item.text : toText(item)))
      .join('')
  }
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    if (typeof record.text === 'string' && Object.keys(record).length <= 3) return record.text
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Parse a tool-call argument payload that may already be an object.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | undefined}
 */
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return /** @type {Record<string, unknown>} */ (raw)
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Count rounds (user → assistant exchanges) in a document.
 * @param {import('./types.js').Transcript} doc
 */
export function countRounds(doc) {
  const ids = new Set()
  for (const message of doc.messages) ids.add(message.turn)
  return ids.size
}

/**
 * Express a byte length the way a person reads it.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Byte length of a string in UTF-8.
 * @param {string} text
 */
export function byteLength(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Escape the characters that would break out of HTML text or an attribute.
 * @param {string} value
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Build a filesystem- and URL-safe slug from a title.
 * @param {string} title
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugify(title, fallback = 'conversation') {
  const normalized = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return normalized.length > 0 ? normalized : fallback
}

/** Local wall-clock stamp used inside documents (not file names). */
function stamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// #endregion
// #region redaction

/**
 * Secret patterns. Every entry keeps its match visible in the *count*, never
 * in the output: the replacement is {@link REDACTED}.
 * Order matters — the most specific patterns run first so a private key is
 * not half-consumed by the generic `key=value` rule.
 */
export const SECRET_PATTERNS = [
  // PEM private keys (multi-line, truncated for the regex by design).
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g },
  // JWT-looking triples.
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  // Well-known provider key shapes.
  { id: 'openai', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'gitlab', pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'stripe', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  // Authorization headers and cookies.
  { id: 'bearer', pattern: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { id: 'cookie', pattern: /\b(?:set-)?cookie\s*:\s*[^\n]{8,}/gi },
  // Generic assignment: key/token/secret/password = value.
  {
    id: 'assignment',
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer[_-]?token|private[_-]?key|password|passwd|pwd)\b\s*[:=]\s*["']?[^\s"',;}]{6,}["']?/gi,
  },
  // Connection strings with credentials.
  { id: 'dsn', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@/gi },
]

/**
 * Replace every detected secret with {@link REDACTED}.
 * @param {string} text
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ text: string, count: number, kinds: string[] }}
 */
export function redactSecrets(text, options = {}) {
  if (options.enabled === false) return { text, count: 0, kinds: [] }
  let out = String(text ?? '')
  let count = 0
  const kinds = new Set()
  for (const { id, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, (match) => {
      count += 1
      kinds.add(id)
      // Keep a recognizable shape for headers so the reader sees what was cut.
      const head = match.match(/^([A-Za-z]+[- ]?[A-Za-z]*\s*:\s*)/)
      return head ? `${head[1]}${REDACTED}` : REDACTED
    })
  }
  return { text: out, count, kinds: [...kinds] }
}

// #endregion
// #region normalization

/**
 * @typedef {object} Block
 * @property {'text'|'tool-call'|'reasoning'|'file'} kind
 * @property {string} [text]
 * @property {string} [name]
 * @property {string} [callId]
 * @property {string} [args]
 * @property {'ok'|'error'|'unknown'} [status]
 * @property {string} [result]
 * @property {string} [path]
 * @property {string} [description]
 *
 * @typedef {object} Message
 * @property {string} id
 * @property {'user'|'assistant'|'tool'} role
 * @property {string} [source]
 * @property {number} turn
 * @property {number} time
 * @property {number} seq
 * @property {Block[]} blocks
 *
 * @typedef {object} Transcript
 * @property {number} schemaVersion
 * @property {{ id: string, title: string, model?: string, cwd?: string, createdAt?: number, exportedAt: number }} session
 * @property {Message[]} messages
 */

/**
 * Turn one raw session event log into the export document model.
 *
 * The log is the append-only event array a session stores (`user/message`,
 * `assistant/message`, `tool/call`, `tool/result`, `session/title`, …). Only
 * message-shaped events survive; everything else (step markers, usage,
 * approvals, jobs) is metadata the reader does not need.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {Array<{ type: string, time?: number, seq?: number, data?: any }>} input.events
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.model]
 * @param {string} [options.cwd]
 * @param {boolean} [options.redact]
 * @param {number} [options.now]
 * @returns {{ doc: Transcript, redactions: number }}
 */
export function normalizeTranscript(input, options = {}) {
  const events = Array.isArray(input.events) ? input.events : []
  const redact = options.redact !== false
  let redactions = 0

  const clean = (value) => {
    const text = toText(value)
    if (!redact) return text
    const result = redactSecrets(text, { enabled: true })
    redactions += result.count
    return result.text
  }

  /** @type {Message[]} */
  const messages = []
  let title = typeof options.title === 'string' ? options.title : ''
  let cwd = typeof options.cwd === 'string' ? options.cwd : undefined
  let createdAt
  /** tool callId → position in the message list, so results can attach. */
  const pending = new Map()
  let lastRole = 'assistant'
  let turn = 0

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data ?? {}
    const time = typeof event.time === 'number' ? event.time : 0
    const seq = typeof event.seq === 'number' ? event.seq : messages.length

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title.trim()
        break
      }
      case 'session': {
        if (typeof data.cwd === 'string') cwd = data.cwd
        if (typeof data.createdAt === 'number') createdAt = data.createdAt
        break
      }
      case 'turn/start': {
        if (typeof data.turn === 'number') turn = data.turn
        break
      }
      case 'user/message': {
        // Runtime scaffolding (runtime context, skill catalog, time sampling,
        // model switches, approval notices) is not part of the conversation a
        // person wants to share, so it is dropped here rather than filtered
        // later in the renderers.
        const source = typeof data.source?.kind === 'string' ? data.source.kind : undefined
        if (source !== undefined && source !== 'user') break
        const blocks = []
        for (const item of Array.isArray(data.content) ? data.content : []) {
          if (!item || typeof item !== 'object') continue
          if (item.type === 'text') {
            const text = clean(item.text)
            if (text.trim() !== '') blocks.push({ kind: 'text', text })
          } else if (item.type === 'image') {
            blocks.push({ kind: 'file', path: item.source?.path ?? item.path ?? '', description: 'image' })
          } else if (typeof item.text === 'string') {
            const text = clean(item.text)
            if (text.trim() !== '') blocks.push({ kind: 'text', text })
          }
        }
        if (blocks.length === 0) break
        if (typeof data.turn === 'number' && data.turn > turn) turn = data.turn
        lastRole = 'user'
        messages.push({
          id: typeof data.id === 'string' ? data.id : `user-${seq}`,
          role: 'user',
          source,
          turn,
          time,
          seq,
          blocks,
        })
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        const blocks = []
        for (const item of Array.isArray(message.content) ? message.content : []) {
          if (!item || typeof item !== 'object') continue
          if (item.type === 'text') {
            const text = clean(item.text)
            if (text.trim() !== '') blocks.push({ kind: 'text', text })
          } else if (item.type === 'reasoning') {
            const text = clean(item.reasoning ?? item.text ?? item.summary)
            if (text.trim() !== '') blocks.push({ kind: 'reasoning', text })
          } else if (item.type === 'tool-call') {
            const callId = String(item.callId ?? item.id ?? `call-${seq}-${blocks.length}`)
            blocks.push({
              kind: 'tool-call',
              name: String(item.name ?? item.toolName ?? 'tool'),
              callId,
              args: clean(item.arguments ?? item.argsRaw ?? ''),
              status: 'unknown',
            })
          }
        }
        if (blocks.length === 0) break
        if (typeof data.turn === 'number' && data.turn > turn) turn = data.turn
        lastRole = 'assistant'
        const index = messages.length
        messages.push({
          id: typeof message.id === 'string' ? message.id : `assistant-${seq}`,
          role: 'assistant',
          turn,
          time,
          seq,
          blocks,
        })
        for (const block of blocks) if (block.kind === 'tool-call') pending.set(String(block.callId), index)
        break
      }
      case 'tool/call': {
        // A call announced outside an assistant message still deserves a row.
        const callId = String(data.callId ?? data.id ?? `call-${seq}`)
        if (pending.has(callId)) break
        const index = messages.length
        messages.push({
          id: `tool-call-${callId}`,
          role: 'assistant',
          turn,
          time,
          seq,
          blocks: [
            {
              kind: 'tool-call',
              name: String(data.name ?? data.toolName ?? 'tool'),
              callId,
              args: clean(data.arguments ?? data.argsRaw ?? data.args ?? ''),
              status: 'unknown',
            },
          ],
        })
        pending.set(callId, index)
        break
      }
      case 'tool/result': {
        const callId = String(data.toolCallId ?? data.callId ?? data.id ?? '')
        const content = data.content ?? data.message?.content ?? data.result
        const isError = data.isError === true || data.status === 'error' || data.outcome === 'error'
        const text = clean(content)
        const owner = pending.get(callId)
        if (owner !== undefined) {
          const block = messages[owner].blocks.find((item) => item.kind === 'tool-call' && String(item.callId) === callId)
          if (block) {
            block.status = isError ? 'error' : 'ok'
            block.result = text
          }
          pending.delete(callId)
        } else if (text.trim() !== '') {
          // Orphan result (its call fell outside the events we were given).
          messages.push({
            id: `tool-result-${seq}`,
            role: 'tool',
            turn,
            time,
            seq,
            blocks: [{ kind: 'tool-call', name: 'tool', callId, args: '', status: isError ? 'error' : 'ok', result: text }],
          })
        }
        break
      }
      case 'deliverables/presented': {
        const files = Array.isArray(data.files) ? data.files : []
        if (files.length === 0) break
        const blocks = files
          .filter((file) => file && typeof file.path === 'string')
          .map((file) => ({
            kind: /** @type {const} */ ('file'),
            path: file.path,
            description: typeof file.description === 'string' ? clean(file.description) : '',
          }))
        if (blocks.length === 0) break
        const previous = messages[messages.length - 1]
        if (previous && previous.role === lastRole) previous.blocks.push(...blocks)
        else
          messages.push({
            id: `files-${seq}`,
            role: /** @type {const} */ ('assistant'),
            turn,
            time,
            seq,
            blocks,
          })
        break
      }
      default:
        break
    }
  }

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    session: {
      id: String(input.sessionId ?? 'session'),
      title: title || 'Conversation',
      ...(typeof options.model === 'string' && options.model !== '' ? { model: options.model } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      exportedAt: typeof options.now === 'number' ? options.now : 0,
    },
    messages,
  }
  return { doc, redactions }
}

// #endregion
// #region ranges and options

/**
 * Options that decide what a render contains. Every flag defaults to the
 * opinionated "what a reader wants" answer: prose plus folded tool calls,
 * no reasoning dump, no timestamps.
 * @typedef {object} RenderOptions
 * @property {boolean} [toolCalls] include tool-call summaries (default true)
 * @property {boolean} [toolResults] include tool output (default true)
 * @property {boolean} [reasoning] include model reasoning (default false)
 * @property {boolean} [timestamps] print a time next to each message (default false)
 * @property {number} [resultChars] truncate each tool result at this many characters (default 6000)
 * @property {string} [language] `zh` or `en`, selects section headings
 */

/**
 * Keep only the last `turns` rounds of a document.
 * @param {Transcript} doc
 * @param {number} [turns] undefined keeps everything
 * @returns {Transcript}
 */
export function sliceTurns(doc, turns) {
  if (!Number.isFinite(turns) || turns <= 0) return doc
  const all = [...new Set(doc.messages.map((message) => message.turn))].sort((a, b) => a - b)
  if (all.length <= turns) return doc
  const keep = new Set(all.slice(-turns))
  return { ...doc, messages: doc.messages.filter((message) => keep.has(message.turn)) }
}

/**
 * Resolve a render option bag into concrete booleans and heading copy.
 * @param {RenderOptions} [options]
 */
export function resolveOptions(options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh'
  return {
    language,
    toolCalls: options.toolCalls !== false,
    toolResults: options.toolResults !== false,
    reasoning: options.reasoning === true,
    timestamps: options.timestamps === true,
    resultChars: Number.isFinite(options.resultChars) ? Math.max(200, Number(options.resultChars)) : 6000,
    copy: COPY[language],
  }
}

const COPY = {
  zh: {
    user: '你',
    assistant: '助手',
    tools: '工具调用',
    reasoning: '思考',
    files: '文件',
    error: '失败',
    arguments: '参数',
    output: '输出',
    round: '第 {n} 轮',
    toc: '目录',
    generated: '导出于',
    model: '模型',
    session: '会话',
    exportFailed: '导出失败',
  },
  en: {
    user: 'You',
    assistant: 'Assistant',
    tools: 'Tool calls',
    reasoning: 'Reasoning',
    files: 'Files',
    error: 'failed',
    arguments: 'arguments',
    output: 'output',
    round: 'Round {n}',
    toc: 'Contents',
    generated: 'Exported',
    model: 'Model',
    session: 'Session',
    exportFailed: 'Export failed',
  },
}

// #endregion
// #region markdown

/**
 * Choose a fence that cannot be closed by the content itself.
 * @param {string} text
 * @param {string} [lang]
 */
function fenceFor(text, lang = '') {
  const longest = Math.max(3, ...(String(text).match(/`{3,}/g) ?? []).map((run) => run.length + 1))
  return `${'`'.repeat(longest)}${lang}`
}

/**
 * Pretty-print a tool argument payload when it parses as JSON.
 * @param {string} raw
 */
function formatArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  try {
    const parsed = JSON.parse(raw)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

/**
 * Truncate long tool output with an explicit marker instead of a silent cut.
 * @param {string} text
 * @param {number} limit
 */
function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  const omitted = text.length - limit
  return `${text.slice(0, limit)}\n… (${omitted} more characters omitted)`
}

/**
 * Render one tool-call block as a `<details>`-free Markdown block: the
 * arguments and output travel in fenced code so they never disturb the
 * surrounding document.
 * @param {Block} block
 * @param {{ copy: typeof COPY.zh, resultChars: number, toolResults: boolean }} context
 */
function renderToolMarkdown(block, context) {
  const lines = []
  const status = block.status === 'error' ? ` — ${context.copy.error}` : ''
  lines.push(`- **\`${block.name ?? 'tool'}\`**${status}`)
  const args = formatArguments(block.args ?? '')
  if (args.trim() !== '' && args.trim() !== '{}') {
    const fence = fenceFor(args, 'json')
    lines.push('', '  ' + fence.replace(/^/, '  ') + 'json')
    for (const line of args.split('\n')) lines.push(`  ${line}`)
    lines.push('  ' + fence)
  }
  if (context.toolResults && typeof block.result === 'string' && block.result.trim() !== '') {
    const result = truncate(block.result, context.resultChars)
    const fence = fenceFor(result, 'text')
    lines.push('', `  ${fence}text`)
    for (const line of result.split('\n')) lines.push(`  ${line}`)
    lines.push(`  ${fence}`)
  }
  return lines.join('\n')
}

/**
 * Render the transcript as Markdown.
 * @param {Transcript} doc
 * @param {RenderOptions} [options]
 * @returns {string}
 */
export function renderMarkdown(doc, options = {}) {
  const resolved = resolveOptions(options)
  const { copy } = resolved
  const out = []
  out.push(`# ${doc.session.title}`)
  out.push('')
  const meta = []
  if (doc.session.model) meta.push(`${copy.model}: \`${doc.session.model}\``)
  if (doc.session.cwd) meta.push(`\`${doc.session.cwd}\``)
  const exportedAt = doc.session.exportedAt ? stamp(doc.session.exportedAt) : stamp(Date.now())
  if (exportedAt) meta.push(`${copy.generated}: ${exportedAt}`)
  if (meta.length > 0) {
    out.push(`> ${meta.join(' · ')}`)
    out.push('')
  }

  let currentTurn = null
  for (const message of doc.messages) {
    if (message.turn !== currentTurn) {
      currentTurn = message.turn
      out.push('---', '', `### ${copy.round.replace('{n}', String(currentTurn + 1))}`, '')
    }
    const speaker = message.role === 'user' ? copy.user : copy.assistant
    const when = resolved.timestamps && message.time ? ` · ${stamp(message.time)}` : ''
    out.push(`**${speaker}**${when}`, '')

    const tools = []
    for (const block of message.blocks) {
      if (block.kind === 'text') {
        out.push(block.text.trimEnd(), '')
      } else if (block.kind === 'reasoning') {
        if (!resolved.reasoning) continue
        out.push('<details>', `<summary>${copy.reasoning}</summary>`, '', block.text.trimEnd(), '', '</details>', '')
      } else if (block.kind === 'tool-call') {
        if (!resolved.toolCalls) continue
        tools.push(block)
      } else if (block.kind === 'file') {
        out.push(`- 📄 \`${block.path}\`${block.description ? ` — ${block.description}` : ''}`)
      }
    }
    if (tools.length > 0) {
      out.push(`<details>`, `<summary>${copy.tools} (${tools.length})</summary>`, '')
      for (const block of tools) out.push(renderToolMarkdown(block, { copy, resultChars: resolved.resultChars, toolResults: resolved.toolResults }), '')
      out.push('</details>', '')
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

// #endregion
// #region html

/** Minimal tokenizer-based highlighter: enough for reading code, no deps. */
const KEYWORDS = /^(?:const|let|var|function|return|if|else|for|while|class|new|await|async|import|export|from|def|elif|try|except|catch|finally|throw|switch|case|break|continue|public|private|static|void|interface|type|enum|struct|impl|fn|match|use|pub|mut|package|func|select|range|go|defer|true|false|null|undefined|None|True|False)$/

/**
 * Whether one identifier is a language keyword.
 * @param {string} token
 */
function isKeyword(token) {
  return KEYWORDS.test(token)
}

/**
 * Highlight one source snippet into safe HTML. This is deliberately small: it
 * colours comments, strings, numbers and keywords, which is what makes code
 * scannable without shipping a 100 KB grammar per language.
 * @param {string} code
 * @param {string} language
 */
export function highlight(code, language = '') {
  const source = String(code ?? '')
  const lang = /^(json|js|javascript|ts|typescript|jsx|tsx|py|python|sh|bash|ps1|powershell|go|rs|rust|java|c|cpp|cs|sql|html|css|yaml|yml|toml|ini|md|markdown)$/i.test(language)
    ? language.toLowerCase()
    : ''
  if (lang === '') return escapeHtml(source)
  // Tokenize the RAW source, escaping each piece on the way out. Escaping
  // first and then matching would leave `&quot;`-style entities inside the
  // tokens, and an entity boundary would re-escape itself.
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
  let out = ''
  let lastIndex = 0
  for (const match of source.matchAll(pattern)) {
    const token = match[0]
    const index = match.index ?? 0
    out += escapeHtml(source.slice(lastIndex, index))
    lastIndex = index + token.length
    const kind = token.startsWith('/*') || token.startsWith('//') || token.startsWith('#')
      ? 'c'
      : token.startsWith('"') || token.startsWith("'")
        ? 's'
        : /^\d/.test(token)
          ? 'n'
          : isKeyword(token)
            ? 'k'
            : ''
    out += kind === '' ? escapeHtml(token) : `<span class="${kind}">${escapeHtml(token)}</span>`
  }
  out += escapeHtml(source.slice(lastIndex))
  return out
}

/**
 * Render the transcript as one self-contained HTML document: inline styles,
 * a clickable table of contents, collapsible tool calls, and no external
 * requests of any kind.
 * @param {Transcript} doc
 * @param {RenderOptions & { theme?: 'auto'|'light'|'dark' }} [options]
 * @returns {string}
 */
export function renderHtml(doc, options = {}) {
  const resolved = resolveOptions(options)
  const { copy } = resolved
  const theme = options.theme === 'light' || options.theme === 'dark' ? options.theme : 'auto'
  const title = doc.session.title || copy.session
  const exportedAt = doc.session.exportedAt ? stamp(doc.session.exportedAt) : stamp(Date.now())
  const rounds = countRounds(doc)

  const sections = []
  const toc = []
  let currentTurn = null
  let roundIndex = 0
  for (const message of doc.messages) {
    if (message.turn !== currentTurn) {
      currentTurn = message.turn
      roundIndex += 1
      const anchor = `round-${roundIndex}`
      const firstText = message.blocks.find((block) => block.kind === 'text')?.text ?? ''
      const label = firstText.split('\n').find((line) => line.trim() !== '') ?? copy.round.replace('{n}', String(roundIndex))
      toc.push({ anchor, label: label.slice(0, 60) })
      sections.push(`<section class="round" id="${anchor}"><h2>${escapeHtml(copy.round.replace('{n}', String(roundIndex)))}</h2>`)
    }
    const speaker = message.role === 'user' ? copy.user : copy.assistant
    const when = resolved.timestamps && message.time ? `<time>${escapeHtml(stamp(message.time))}</time>` : ''
    const body = []
    for (const block of message.blocks) {
      if (block.kind === 'text') {
        body.push(`<div class="prose">${renderMarkupText(block.text ?? '')}</div>`)
      } else if (block.kind === 'reasoning') {
        if (!resolved.reasoning) continue
        body.push(
          `<details class="reasoning"><summary>${escapeHtml(copy.reasoning)}</summary><div class="prose">${renderMarkupText(block.text ?? '')}</div></details>`,
        )
      } else if (block.kind === 'tool-call') {
        if (!resolved.toolCalls) continue
        const status = block.status === 'error' ? `<span class="badge err">${escapeHtml(copy.error)}</span>` : ''
        const args = formatArguments(block.args ?? '')
        const argHtml = args.trim() === '' || args.trim() === '{}'
          ? ''
          : `<div class="lab">${escapeHtml(copy.arguments)}</div><pre><code>${highlight(args, 'json')}</code></pre>`
        const output = resolved.toolResults && block.result ? `<div class="lab">${escapeHtml(copy.output)}</div><pre><code>${escapeHtml(truncate(block.result, resolved.resultChars))}</code></pre>` : ''
        body.push(
          `<details class="tool"><summary><code>${escapeHtml(block.name ?? 'tool')}</code>${status}</summary>${argHtml}${output}</details>`,
        )
      } else if (block.kind === 'file') {
        body.push(`<div class="file"><span class="mono">${escapeHtml(block.path ?? '')}</span>${block.description ? ` — ${escapeHtml(block.description)}` : ''}</div>`)
      }
    }
    sections.push(
      `<article class="msg ${message.role}"><header><span class="who">${escapeHtml(speaker)}</span>${when}</header>${body.join('')}</article>`,
    )
  }
  if (sections.length > 0) sections.push('</section>')

  const metaBits = []
  if (doc.session.model) metaBits.push(`<span>${escapeHtml(copy.model)}: <code>${escapeHtml(doc.session.model)}</code></span>`)
  if (doc.session.cwd) metaBits.push(`<span><code>${escapeHtml(doc.session.cwd)}</code></span>`)
  metaBits.push(`<span>${escapeHtml(copy.generated)} ${escapeHtml(exportedAt)}</span>`)

  const tocHtml = toc.length > 1
    ? `<nav class="toc"><h2>${escapeHtml(copy.toc)}</h2><ol>${toc
        .map((entry) => `<li><a href="#${entry.anchor}">${escapeHtml(entry.label)}</a></li>`)
        .join('')}</ol></nav>`
    : ''

  return `<!doctype html>
<html lang="${resolved.language === 'en' ? 'en' : 'zh-CN'}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="dsh-session-share">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
<style>${HTML_CSS}</style>
</head>
<body>
<main>
<header class="doc">
<h1>${escapeHtml(title)}</h1>
<div class="meta">${metaBits.join('')}</div>
<div class="meta"><span>${rounds} ×</span><span>${doc.messages.length} msg</span></div>
</header>
${tocHtml}
${sections.join('\n')}
<footer>dsh-session-share · ${escapeHtml(exportedAt)}</footer>
</main>
<script>${HTML_JS}</script>
</body>
</html>
`
}

/**
 * Render one message's prose. The message text is Markdown already, so the
 * safe move is to *not* re-parse it: it is shown in a preformatted block with
 * soft wrapping, which keeps every list, table and code fence exactly as the
 * model wrote it and cannot be exploited.
 * @param {string} text
 */
function renderMarkupText(text) {
  return `<div class="raw">${escapeHtml(text)}</div>`
}

const HTML_CSS = `
:root{color-scheme:light dark}
@media (prefers-color-scheme:dark){html[data-theme=auto]{--bg:#0f1115;--fg:#e6e6e6;--muted:#9aa0a6;--line:#262a31;--card:#161a20;--accent:#6ea8fe;--code:#101318}}
html[data-theme=light]{--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--card:#f7f8fa;--accent:#2563eb;--code:#f3f4f6;color-scheme:light}
html[data-theme=dark]{--bg:#0f1115;--fg:#e6e6e6;--muted:#9aa0a6;--line:#262a31;--card:#161a20;--accent:#6ea8fe;--code:#101318;color-scheme:dark}
html[data-theme=auto]:not([data-resolved]){--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--card:#f7f8fa;--accent:#2563eb;--code:#f3f4f6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 20px 96px}
header.doc h1{font-size:30px;line-height:1.3;margin:0 0 12px}
header.doc .meta{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:13px;margin-bottom:4px}
nav.toc{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 18px;margin:28px 0}
nav.toc h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
nav.toc ol{margin:0;padding-left:20px}
nav.toc a{color:var(--accent);text-decoration:none}
nav.toc a:hover{text-decoration:underline}
section.round{margin:40px 0 0;padding-top:8px;border-top:1px solid var(--line)}
section.round>h2{font-size:13px;color:var(--muted);font-weight:600;letter-spacing:.04em;margin:16px 0}
article.msg{margin:18px 0;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
article.msg.user{border-color:color-mix(in srgb,var(--accent) 35%,var(--line))}
article.msg header{display:flex;gap:10px;align-items:baseline;margin-bottom:8px}
article.msg .who{font-weight:600;font-size:14px}
article.msg time{color:var(--muted);font-size:12px}
.raw{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
details{margin:10px 0;border:1px dashed var(--line);border-radius:10px;padding:8px 12px}
details>summary{cursor:pointer;color:var(--muted);font-size:13px;user-select:none}
details[open]>summary{margin-bottom:8px}
pre{background:var(--code);border-radius:8px;padding:12px;overflow:auto;margin:6px 0;font-size:13px;line-height:1.55}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.lab{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:8px}
.badge{margin-left:8px;padding:1px 6px;border-radius:999px;font-size:11px}
.badge.err{background:color-mix(in srgb,red 18%,transparent);color:color-mix(in srgb,red 78%,var(--fg))}
.file{margin:6px 0;color:var(--muted);font-size:14px}
.k{color:#c678dd}.s{color:#98c379}.n{color:#d19a66}.c{color:#7f848e;font-style:italic}
footer{margin-top:56px;color:var(--muted);font-size:12px;text-align:center}
@media print{body{background:#fff;color:#000}article.msg{break-inside:avoid;border-color:#ddd}details{border-color:#ddd}details.tool,details.reasoning{display:none}nav.toc{display:none}}
`

const HTML_JS = `
(function(){
  var root=document.documentElement;
  if(root.getAttribute('data-theme')!=='auto')return;
  var mq=window.matchMedia('(prefers-color-scheme: dark)');
  var apply=function(){root.setAttribute('data-resolved','');root.style.colorScheme=mq.matches?'dark':'light'};
  apply();
  if(mq.addEventListener)mq.addEventListener('change',apply);
})();
`

// #endregion
// #region json

/**
 * Render the transcript as JSON: the document model plus a small envelope so a
 * consumer can tell which tool produced it.
 * @param {Transcript} doc
 * @param {RenderOptions & { redactions?: number }} [options]
 * @returns {string}
 */
export function renderJson(doc, options = {}) {
  const resolved = resolveOptions(options)
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'dsh-session-share', version: '0.1.0' },
    exportedAt: doc.session.exportedAt ? new Date(doc.session.exportedAt).toISOString() : new Date().toISOString(),
    redactions: Number.isFinite(options.redactions) ? Number(options.redactions) : 0,
    options: {
      toolCalls: resolved.toolCalls,
      toolResults: resolved.toolResults,
      reasoning: resolved.reasoning,
      timestamps: resolved.timestamps,
    },
    session: doc.session,
    rounds: countRounds(doc),
    messages: doc.messages,
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

// #endregion

/** Format → `{ extension, language, contentType }`. */
export const FORMATS = {
  markdown: { extension: 'md', contentType: 'text/markdown; charset=utf-8' },
  html: { extension: 'html', contentType: 'text/html; charset=utf-8' },
  json: { extension: 'json', contentType: 'application/json; charset=utf-8' },
}

/**
 * Render a document in one of the three formats.
 * @param {Transcript} doc
 * @param {'markdown'|'html'|'json'} format
 * @param {RenderOptions & { redactions?: number, theme?: 'auto'|'light'|'dark' }} [options]
 * @returns {{ content: string, extension: string, contentType: string }}
 */
export function renderDocument(doc, format, options = {}) {
  const spec = FORMATS[format] ?? FORMATS.markdown
  const content =
    format === 'html' ? renderHtml(doc, options) : format === 'json' ? renderJson(doc, options) : renderMarkdown(doc, options)
  return { content, extension: spec.extension, contentType: spec.contentType }
}
