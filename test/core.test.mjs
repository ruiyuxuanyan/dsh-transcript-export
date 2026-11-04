// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FORMATS,
  SCHEMA_VERSION,
  byteLength,
  countRounds,
  escapeHtml,
  formatBytes,
  highlight,
  looksLikeTextPath,
  normalizeTranscript,
  redactSecrets,
  renderDocument,
  renderHtml,
  renderJson,
  renderMarkdown,
  sliceTurns,
  slugify,
  toText,
} from '../lib/core.js'

/** A small but representative event log: scaffolding, tools, reasoning, secrets. */
function sampleEvents() {
  return [
    { type: 'session', seq: 0, time: 1000, data: { version: 4, id: 's1', createdAt: 900, cwd: 'D:\\work\\demo' } },
    { type: 'session/title', seq: 1, time: 1001, data: { title: '修一个登录 bug', source: { kind: 'fallback' } } },
    {
      type: 'user/message',
      seq: 2,
      time: 1100,
      data: { id: 'u0', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime scaffolding that must not appear' }] },
    },
    {
      type: 'turn/start',
      seq: 3,
      time: 1101,
      data: { turn: 0 },
    },
    {
      type: 'user/message',
      seq: 4,
      time: 1200,
      data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '登录接口 500 了,帮我看看' }] },
    },
    {
      type: 'assistant/message',
      seq: 5,
      time: 1300,
      data: {
        turn: 0,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 20 },
        message: {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看看日志' },
            { type: 'tool-call', callId: 'call_1', name: 'grep', arguments: '{"pattern":"ERROR","path":"src"}' },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      seq: 6,
      time: 1400,
      data: { toolCallId: 'call_1', message: { role: 'tool' }, content: [{ type: 'text', text: 'src/auth.ts:42 ERROR token=sk-abcdef0123456789abcdef failed' }] },
    },
    {
      type: 'assistant/message',
      seq: 7,
      time: 1500,
      data: {
        turn: 0,
        message: {
          id: 'a2',
          role: 'assistant',
          content: [
            { type: 'text', text: '找到了:token 过期判断写反了。\n\n```ts\nif (!expired) throw new Error("401")\n```' },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 8, time: 1600, data: { turn: 0, reason: { kind: 'completed' } } },
    {
      type: 'user/message',
      seq: 9,
      time: 2000,
      data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '那密码 password=hunter2 也帮我改掉' }] },
    },
    {
      type: 'turn/start',
      seq: 10,
      time: 2001,
      data: { turn: 1 },
    },
    {
      type: 'assistant/message',
      seq: 11,
      time: 2100,
      data: { turn: 1, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '好了。' }] } },
    },
    {
      type: 'deliverables/presented',
      seq: 12,
      time: 2200,
      data: { turn: 1, files: [{ path: 'D:\\work\\demo\\report.md', description: '修复说明' }] },
    },
  ]
}

test('normalizeTranscript keeps conversation and drops scaffolding', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { title: 'ignored', now: 5000 })
  assert.equal(doc.schemaVersion, SCHEMA_VERSION)
  assert.equal(doc.session.title, '修一个登录 bug')
  assert.equal(doc.session.cwd, 'D:\\work\\demo')
  assert.equal(doc.session.exportedAt, 5000)
  const texts = JSON.stringify(doc)
  assert.ok(!texts.includes('runtime scaffolding'), 'runtime-context user message is not part of the conversation')
  assert.equal(doc.messages.filter((m) => m.role === 'user').length, 2)
  const first = doc.messages.find((m) => m.role === 'assistant')
  assert.equal(first.blocks.filter((b) => b.kind === 'tool-call').length, 1)
  assert.equal(countRounds(doc), 2)
})

test('normalizeTranscript attaches tool results to their call', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { redact: false })
  const call = doc.messages.flatMap((m) => m.blocks).find((b) => b.kind === 'tool-call')
  assert.equal(call.status, 'ok')
  assert.match(call.result, /ERROR token=sk-/)
})

test('normalizeTranscript redacts secrets by default and reports the count', () => {
  const { doc, redactions } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() })
  const flat = JSON.stringify(doc)
  assert.ok(!flat.includes('sk-abcdef0123456789abcdef'), 'openai-style key removed')
  assert.ok(!flat.includes('hunter2'), 'password value removed')
  assert.ok(flat.includes('[REDACTED]'))
  assert.ok(redactions >= 2, `expected at least two redactions, got ${redactions}`)
})

test('redactSecrets covers the common credential shapes', () => {
  const cases = [
    'sk-abcdef0123456789abcdef',
    'ghp_012345678901234567890123456789012345',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'postgres://user:s3cretpass@db.local:5432/app',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ]
  for (const text of cases) {
    const result = redactSecrets(text)
    assert.ok(result.count >= 1, `not redacted: ${text}`)
    assert.ok(!result.text.includes('s3cretpass') && !result.text.includes('abcdef0123456789'), `leaked: ${result.text}`)
  }
  assert.equal(redactSecrets('nothing to see here').count, 0)
  assert.equal(redactSecrets(cases[0], { enabled: false }).count, 0)
})

test('sliceTurns keeps the last N rounds', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { redact: false })
  const cut = sliceTurns(doc, 1)
  assert.equal(countRounds(cut), 1)
  assert.ok(cut.messages.every((m) => m.turn === 1))
  assert.equal(sliceTurns(doc, 99), doc)
  assert.equal(sliceTurns(doc, 0), doc)
})

test('renderMarkdown produces a shareable document', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { redact: false, now: 5000 })
  const md = renderMarkdown(doc, { language: 'zh' })
  assert.match(md, /^# 修一个登录 bug/)
  assert.match(md, /### 第 1 轮/)
  assert.match(md, /### 第 2 轮/)
  assert.match(md, /\*\*你\*\*/)
  assert.match(md, /grep/)
  assert.ok(!md.includes('先看看日志'), 'reasoning is off by default')
  assert.match(renderMarkdown(doc, { reasoning: true }), /先看看日志/)
  assert.ok(!md.includes('runtime scaffolding'))
  const withoutTools = renderMarkdown(doc, { toolCalls: false })
  assert.ok(!withoutTools.includes('grep'))
  // Fences must survive content that itself contains fences.
  const nested = normalizeTranscript({
    sessionId: 'x',
    events: [{ type: 'assistant/message', seq: 0, time: 1, data: { turn: 0, message: { content: [{ type: 'text', text: '```js\nconst a = 1\n```' }] } } }],
  }).doc
  assert.ok(renderMarkdown(nested).includes('```js'))
})

test('tool fences are well formed inside a list item', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { redact: false })
  const md = renderMarkdown(doc)
  // Every fence line is either an opening fence (```lang) or a bare closing
  // fence; a closing fence that carries a language tag nests a broken block.
  const fenceLines = md.split('\n').filter((line) => line.trim().startsWith('```'))
  const closings = fenceLines.filter((line) => /^\s*`{3,}\s*$/.test(line))
  const openings = fenceLines.filter((line) => !/^\s*`{3,}\s*$/.test(line))
  assert.equal(closings.length, openings.length, `unbalanced fences:\n${fenceLines.join('\n')}`)
  assert.ok(!/```\w+```/.test(md.replace(/\n/g, '')), 'no fused open/close fence')
  assert.ok(!/^ {2}```jsonjson/m.test(md))
  // A tool output whose own text contains a fence must not close the block.
  const tricky = normalizeTranscript({
    sessionId: 'x',
    events: [
      {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        data: {
          turn: 0,
          message: {
            content: [
              { type: 'tool-call', callId: 'c1', name: 'read', arguments: '{"path":"a.md"}' },
            ],
          },
        },
      },
      { type: 'tool/result', seq: 1, time: 2, data: { toolCallId: 'c1', content: '```js\ncode\n```' } },
      { type: 'assistant/message', seq: 2, time: 3, data: { turn: 0, message: { content: [{ type: 'text', text: 'after' }] } } },
    ],
  }, { redact: false }).doc
  const out = renderMarkdown(tricky)
  const after = out.slice(out.indexOf('after'))
  assert.ok(after.length > 0, 'the reply after a fenced tool result survives')
})

test('renderHtml is self-contained and escapes hostile text', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { redact: false, now: 5000 })
  const html = renderHtml(doc)
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('<style>'))
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts')
  assert.ok(!/<link[^>]+href="(?!data:)/.test(html), 'no external stylesheets')
  assert.match(html, /id="round-1"/)
  assert.match(html, /nav class="toc"/)

  const hostile = normalizeTranscript({
    sessionId: 'x',
    events: [
      {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        data: { turn: 0, message: { content: [{ type: 'text', text: '<img src=x onerror="alert(1)"><script>alert(2)</script>' }] } },
      },
    ],
  }, { redact: false }).doc
  const out = renderHtml(hostile)
  assert.ok(!out.includes('<img src=x'), 'raw markup escaped')
  assert.ok(!out.includes('<script>alert(2)'), 'script escaped')
})

test('highlight escapes and colours tokens', () => {
  const out = highlight('const a = "<script>" // note', 'js')
  assert.ok(out.includes('class="k"'))
  assert.ok(out.includes('&lt;script&gt;'))
  assert.ok(out.includes('class="c"'))
  assert.equal(highlight('<b>', ''), '&lt;b&gt;')
})

test('renderJson round-trips and records options', () => {
  const { doc, redactions } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() }, { now: 5000 })
  const json = renderJson(doc, { redactions, toolResults: false })
  const parsed = JSON.parse(json)
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION)
  assert.equal(parsed.generator.name, 'dsh-session-share')
  assert.equal(parsed.redactions, redactions)
  assert.equal(parsed.rounds, 2)
  assert.equal(parsed.options.toolResults, false)
  assert.ok(Array.isArray(parsed.messages))
})

test('renderDocument picks the right extension per format', () => {
  const { doc } = normalizeTranscript({ sessionId: 's1', events: sampleEvents() })
  for (const format of Object.keys(FORMATS)) {
    const result = renderDocument(doc, format)
    assert.equal(result.extension, FORMATS[format].extension)
    assert.ok(result.content.length > 0)
  }
})

test('small helpers behave', () => {
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(byteLength('ab'), 2)
  assert.equal(byteLength('中'), 3)
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;')
  assert.equal(slugify('修一个登录 bug'), '修一个登录-bug')
  assert.equal(slugify('自动模拟ETF交易面板'), '自动模拟ETF交易面板')
  assert.equal(slugify('!!!'), 'conversation')
  assert.ok(looksLikeTextPath('a/b.md'))
  assert.ok(!looksLikeTextPath('a/b.png'))
  assert.equal(toText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
})
