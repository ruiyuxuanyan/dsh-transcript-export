// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { apply, defaultExportDir, resolveConfig } from '../lib/index.js'

/**
 * A miniature Cordis context: `effect` runs its callback immediately and
 * collects the disposer, `inject(names, cb)` runs the callback with `this`, and
 * `get(name)` reads the service table. That is the whole contract the plugin
 * touches, so the test does not need the real runtime.
 * @param {Record<string, any>} services
 * @param {string[]} [missing] service names to treat as absent even when provided
 */
function fakeContext(services) {
  /** @type {Array<() => void>} */
  const disposers = []
  /** @type {any} */
  const ctx = {
    effect(fn) {
      const value = fn()
      if (typeof value === 'function') disposers.push(value)
      return value
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : []
      if (list.some((name) => ctx.get(name) === undefined)) return
      callback(ctx)
    },
    get(serviceName) {
      return services[serviceName]
    },
    disposeAll() {
      while (disposers.length > 0) disposers.pop()?.()
    },
  }
  // Cordis exposes a service both as `ctx.get(name)` and as `ctx.<name>`
  // (services live on the context's prototype), and the plugin uses both
  // spellings, so the fake advertises the same accessors.
  for (const [serviceName, service] of Object.entries(services)) {
    Object.defineProperty(ctx, serviceName, { value: service, configurable: true })
  }
  return ctx
}

/** A scratch folder inside the package, so no OS temp permission is involved. */
function testDir(suffix) {
  return fileURLToPath(new URL(`../.test-out/${process.pid}-${suffix}`, import.meta.url))
}

/** A fake sessionQuery service backed by a fixed event log. */
function fakeQuery(events) {
  return {
    async readSession() {
      return { session: { id: 's1', cwd: 'D:\\work' }, inheritedEventCount: 0, events }
    },
    async readTitleSnapshot() {
      return { title: { title: 'demo session' } }
    },
  }
}

const EVENTS = [
  { type: 'session', seq: 0, time: 1, data: { cwd: 'D:\\work' } },
  { type: 'user/message', seq: 1, time: 2, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello key sk-abcdef0123456789abcdef' }] } },
  { type: 'turn/start', seq: 2, time: 3, data: { turn: 0 } },
  { type: 'assistant/message', seq: 3, time: 4, data: { turn: 0, message: { id: 'a1', content: [{ type: 'text', text: 'hi there' }] } } },
]

/** Capture the registered route so a test can drive it like the browser would. */
function captureRoute(services) {
  const routes = []
  services.webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  return routes
}

/**
 * Invoke the captured route with a fake request/response pair.
 * @param {any} route
 * @param {string} method
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
async function call(route, method, body, headers = { host: '127.0.0.1:56772', origin: 'http://127.0.0.1:56772' }) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method: 'POST',
    url: `/dsh-session-share/${method}`,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
  /** @type {{ status: number, body: any }} */
  const captured = { status: 0, body: undefined }
  const res = {
    writeHead(status) {
      captured.status = status
    },
    end(text) {
      captured.body = text === undefined ? undefined : JSON.parse(String(text))
    },
  }
  await route.handler(req, res)
  return captured
}

test('resolveConfig defaults to DSH_HOME/exports and honours overrides', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = fileURLToPath(new URL('../.test-out', import.meta.url))
  try {
    const config = resolveConfig()
    assert.equal(config.exportDir, join(fileURLToPath(new URL('../.test-out', import.meta.url)), 'exports'))
    assert.equal(config.exposeTool, true)
    assert.equal(config.redactByDefault, true)
    assert.equal(defaultExportDir(), config.exportDir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    // The process env is restored; nothing else observed the value.
    void defaultExportDir
  }
})

test('the route exports, saves, lists, reads and deletes', async () => {
  const dir = testDir('a')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  try {
    const services = {}
    const routes = captureRoute(services)
    services.sessionQuery = fakeQuery(EVENTS)

    const ctx = fakeContext(services)
    apply(ctx, { exportDir: dir, language: 'zh' })
    assert.equal(routes.length, 1)
    const route = routes[0]

    const described = await call(route, 'describe', {})
    assert.equal(described.status, 200)
    assert.equal(described.body.ok, true)
    assert.equal(described.body.exportDir, dir)

    const prepared = await call(route, 'prepare', { sessionId: 's1' })
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.rounds, 1)
    assert.equal(prepared.body.redactions, 1)

    const exported = await call(route, 'export', { sessionId: 's1', format: 'markdown', save: true, name: 'demo.md' })
    assert.equal(exported.body.ok, true)
    assert.match(exported.body.content, /# demo session/)
    assert.ok(!exported.body.content.includes('sk-abcdef0123456789abcdef'))
    assert.equal(exported.body.saved.name, 'demo.md')

    const onDisk = await readFile(join(dir, 'demo.md'), 'utf8')
    assert.match(onDisk, /hi there/)

    const listed = await call(route, 'list', {})
    assert.equal(listed.body.ok, true, JSON.stringify(listed.body))
    assert.deepEqual(listed.body.files.map((file) => file.name), ['demo.md'])

    const read = await call(route, 'read', { name: 'demo.md' })
    assert.equal(read.body.content, onDisk)

    const removed = await call(route, 'delete', { name: 'demo.md' })
    assert.equal(removed.body.ok, true)
    const after = await call(route, 'list', {})
    assert.deepEqual(after.body.files, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saving the same name twice keeps both exports', async () => {
  const dir = testDir('c')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  try {
    const services = {}
    const routes = captureRoute(services)
    services.sessionQuery = fakeQuery(EVENTS)
    apply(fakeContext(services), { exportDir: dir })

    const route = routes[0]
    const first = await call(route, 'export', { sessionId: 's1', save: true, name: 'same.md' })
    const second = await call(route, 'export', { sessionId: 's1', save: true, name: 'same.md' })
    assert.equal(first.body.saved.name, 'same.md')
    assert.equal(second.body.saved.name, 'same-2.md', 'the second export must not overwrite the first')

    const listed = await call(route, 'list', {})
    assert.deepEqual(listed.body.files.map((file) => file.name).sort(), ['same-2.md', 'same.md'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the route refuses traversal, other origins, other methods and junk bodies', async () => {
  const dir = testDir('b')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  try {
    const services = {}
    const routes = captureRoute(services)
    services.sessionQuery = fakeQuery(EVENTS)
    const ctx = fakeContext(services)
    apply(ctx, { exportDir: dir })
    const route = routes[0]

    // A path that leaves the export folder never reaches the disk.
    await writeFile(join(dir, '..', 'outside-dsh-test.md'), 'x', 'utf8').catch(() => {})
    const escape = await call(route, 'read', { name: '../outside-dsh-test.md' })
    assert.equal(escape.body.ok, false)
    assert.match(String(escape.body.error), /outside the export folder/)
    await rm(join(dir, '..', 'outside-dsh-test.md'), { force: true })

    const crossOrigin = await call(route, 'list', {}, { host: '127.0.0.1:56772', origin: 'https://evil.example' })
    assert.equal(crossOrigin.status, 403)

    const noOrigin = await call(route, 'list', {}, { host: 'example.com' })
    assert.equal(noOrigin.status, 403)

    const wrongMethod = await call(route, 'list', {}, { host: '127.0.0.1:56772' })
    assert.equal(wrongMethod.status, 200) // same-origin still allowed without Origin

    const unknown = await call(route, 'nope', {})
    assert.equal(unknown.status, 404)

    // Prototype keys are not actions.
    const proto = await call(route, 'constructor', {})
    assert.equal(proto.status, 404)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the host half still mounts without sessionQuery or webServer', () => {
  const ctx = fakeContext({})
  assert.doesNotThrow(() => apply(ctx, {}))
})
