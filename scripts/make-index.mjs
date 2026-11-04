#!/usr/bin/env node
/**
 * Build `market/index.json` — a plugin market index in format 1.
 *
 * dsh has no central registry to submit to: a market UI reads *index documents*
 * whose URL a user adds under Settings → Plugins → Discover → Index sources.
 * This script renders our own source from the repo, so anyone can add it and
 * install with one click. Run it before a release so the pinned commit matches
 * the tag.
 *
 *   node scripts/make-index.mjs --repo https://github.com/<you>/dsh-transcript-export
 *
 * Format 1 is defined by `@deepseek-ai/dsh-plugin-market-index`; the fields
 * below are the ones that validator accepts, and the last step re-checks our
 * output against that package when it happens to be installed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

const repository = argument('repo', pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, ''))
if (!repository || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(repository)) {
  console.error('需要仓库地址: --repo https://github.com/<owner>/<name>')
  process.exit(1)
}

// Accept a branch, tag or `HEAD` as well as the literal SHA: the point is to
// pin whatever the release ref resolves to right now.
const requestedCommit = argument('commit', 'HEAD')
const commit = /^[0-9a-f]{40}$/u.test(requestedCommit) ? requestedCommit : git('rev-parse', requestedCommit)
if (!/^[0-9a-f]{40}$/u.test(commit)) {
  console.error(`commit 必须是 40 位小写十六进制（或一个能解析成它的 ref）: ${requestedCommit}`)
  process.exit(1)
}

// A package that is on npm installs with one command; a git entry needs the
// full `git+https://…#<sha>` spec. Publish to npm first, then leave this at the
// default; use `--source git` only when the registry has nothing to serve.
const source = argument('source', 'npm')
if (source !== 'npm' && source !== 'git') {
  console.error(`--source 只能是 npm 或 git: ${source}`)
  process.exit(1)
}

if (repository.includes('/example/')) {
  console.warn('⚠ 仓库地址还是占位符：发布前用 --repo https://github.com/<你>/dsh-transcript-export 重新生成一次。')
}

/** Unix seconds; the market sorts and displays this. */
const publishTimestamp = Math.floor(
  new Date(argument('date', git('show', '-s', '--format=%cI', commit))).getTime() / 1000,
)

const index = {
  format: 1,
  title: { en: 'DSH Transcript Export', zh: 'DSH 会话导出' },
  description: {
    en: 'The plugin index shipped alongside dsh-transcript-export.',
    zh: '与 dsh-transcript-export 一起发布的插件索引。',
  },
  metadata: {
    categories: { export: { title: { en: 'Export & Share', zh: '导出与分享' } } },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Transcript Export', zh: '会话导出' },
      description: {
        en: 'Turn any reply into a document you can hand to someone: clean Markdown, one self-contained HTML file, or JSON. Take the last N turns, get tool calls folded into one appendix per round, real Markdown structure with a table of contents, and secrets redacted by default — all read from the session log, never modified.',
        zh: '把任意一条回复变成能拿给人看的文档：干净的 Markdown、单文件 HTML 或 JSON。可以只导最近 N 轮，工具调用整轮折进一个附录，正文是真 Markdown 结构还带目录，密钥默认脱敏——全程只读会话日志，不改动它。',
      },
      author: pkg.author?.name ?? pkg.author ?? undefined,
      homepage: pkg.homepage,
      repository: { url: repository },
      metadata: {
        category: 'export',
        keywords: ['export', 'markdown', 'html', 'share', 'transcript', 'conversation', 'redact'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: source === 'npm' ? { type: 'npm' } : { type: 'git', url: repository, commit },
        },
      ],
    },
  ],
}

// Drop the members we have no value for, so the document stays clean.
for (const key of ['author', 'homepage']) if (index.plugins[0][key] === undefined) delete index.plugins[0][key]

const target = join(root, 'market', 'index.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

const { plugins } = index
const version = plugins[0].versions[0]
console.log(`wrote ${target}`)
console.log(`  ${plugins[0].name}@${version.version} -> ${repository}@${commit.slice(0, 8)}`)

// Validate with the real parser when the harness ships it next to us.
try {
  const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
  const url = `https://raw.githubusercontent.com/${repository.replace('https://github.com/', '')}/main/market/index.json`
  parseMarketIndex(JSON.parse(readFileSync(target, 'utf8')), url)
  console.log('  validated against @deepseek-ai/dsh-plugin-market-index')
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') console.log('  (validator not installed here; skipped the extra check)')
  else {
    console.error(`  INVALID: ${error.message}`)
    process.exit(1)
  }
}