/**
 * dsh-transcript-export — browser half.
 *
 * Mounts one icon button into `conversation.chat.assistant-actions` (the row
 * that already holds Copy and Branch) and one entry into the chat header
 * actions. Both open the same dialog: pick a format and a range, then either
 * download the rendered file or keep a copy in the export folder, where the
 * library can list, reopen and delete it.
 *
 * Everything the dialog exports is produced by the Host half over
 * `POST /dsh-transcript-export/<action>`, so the browser never needs the session
 * log and the same code path serves the agent's `export_session` tool.
 *
 * The module is plain CommonJS evaluated by the Harness client loader; the
 * only imports allowed are the loader's own (`react`, `react/jsx-runtime`,
 * `@deepseek-ai/dsh-client-ui-primitives`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-transcript-export',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const Button = primitives.Button
    const Modal = primitives.Modal
    const Tooltip = primitives.Tooltip
    const IconDownload = primitives.IconDownloadOutlineRegular || primitives.IconSaveOutlineRegular
    const IconLibrary = primitives.IconFolderOutlineRegular || primitives.IconDownloadOutlineRegular
    const IconClose = primitives.IconCloseOutlineRegular

    const NS = 'dsh-transcript-export'
    const ROUTE = '/dsh-transcript-export'

    const zh = {
      actionTitle: '导出 / 分享这段对话',
      libraryAction: '导出库',
      dialogTitle: '导出对话',
      dialogSubtitle: '选择格式与回溯范围。不会上传任何内容：文件只写在这台机器上。',
      format: '格式',
      formatMarkdown: 'Markdown',
      formatMarkdownHint: '纯文本，diff 友好，可直接粘进编辑器或笔记',
      formatHtml: 'HTML',
      formatHtmlHint: '单文件自包含，离线双击即可用浏览器打开',
      formatJson: 'JSON',
      formatJsonHint: '结构化记录，适合脚本处理与备份',
      range: '范围',
      whole: '整段对话',
      recent: '最近',
      turns: '最近 {count} 轮',
      content: '内容',
      toolCalls: '工具调用',
      toolResults: '工具结果',
      reasoning: '思考过程',
      timestamps: '时间戳',
      redact: '脱敏密钥',
      redactHint: 'API Key、Token、密码、私钥会被替换成占位符。',
      redacted: '已脱敏 {count} 处。',
      nothingRedacted: '没有检测到需要脱敏的内容。',
      save: '同时留一份',
      saveHint: '写入 {dir}，之后可以在导出库里找回来。',
      export: '导出',
      cancel: '取消',
      close: '关闭',
      copy: '复制',
      copied: '已复制',
      exporting: '正在写入…',
      loading: '正在读取…',
      downloaded: '已下载 {name}',
      saved: '已保存 {name}',
      summary: '{messages} 条消息 · {rounds} 轮 · 约 {size}',
      empty: '这段对话还没有可导出的消息。',
      loadError: '无法读取这段对话：{message}',
      exportError: '导出失败：{message}',
      routeError: '联系不上导出服务。请刷新页面；若仍不行，说明插件的 Host 半边没有运行。',
      libraryTitle: '导出库',
      librarySubtitle: '这个插件在这台机器上保存过的所有导出。',
      libraryEmpty: '还没有保存过导出。',
      colName: '文件',
      colSize: '大小',
      colTime: '创建时间',
      filter: '按文件名筛选',
      refresh: '刷新',
      delete: '删除',
      open: '打开',
      reveal: '在文件夹中显示',
      count: '{count} 个文件',
    }

    const en = {
      actionTitle: 'Export / share this conversation',
      libraryAction: 'Export library',
      dialogTitle: 'Export conversation',
      dialogSubtitle: 'Pick a format and how far back to include. Nothing is uploaded: the file is written on this machine.',
      format: 'Format',
      formatMarkdown: 'Markdown',
      formatMarkdownHint: 'Plain text, diffs cleanly, pastes into any editor',
      formatHtml: 'HTML',
      formatHtmlHint: 'One self-contained file, opens offline in a browser',
      formatJson: 'JSON',
      formatJsonHint: 'Structured transcript for scripts and backups',
      range: 'Include',
      whole: 'Whole conversation',
      recent: 'Last',
      turns: 'Last {count} rounds',
      content: 'Content',
      toolCalls: 'Tool calls',
      toolResults: 'Tool results',
      reasoning: 'Reasoning',
      timestamps: 'Timestamps',
      redact: 'Redact secrets',
      redactHint: 'API keys, tokens, passwords and private keys become a placeholder.',
      redacted: 'Redacted {count} secret(s).',
      nothingRedacted: 'Nothing was redacted.',
      save: 'Also keep a copy',
      saveHint: 'Written to {dir} and listed in the export library.',
      export: 'Export',
      cancel: 'Cancel',
      close: 'Close',
      copy: 'Copy',
      copied: 'Copied',
      exporting: 'Writing…',
      loading: 'Reading…',
      downloaded: 'Downloaded {name}',
      saved: 'Saved {name}',
      summary: '{messages} messages · {rounds} rounds · about {size}',
      empty: 'This conversation has no exportable messages yet.',
      loadError: 'Could not read this conversation: {message}',
      exportError: 'Export failed: {message}',
      routeError: 'The exporter is not reachable. Reload the page; if that keeps happening the Host half is not running.',
      libraryTitle: 'Export library',
      librarySubtitle: 'Every export this plugin saved on this machine.',
      libraryEmpty: 'No saved exports yet.',
      colName: 'File',
      colSize: 'Size',
      colTime: 'Created',
      filter: 'Filter by name',
      refresh: 'Refresh',
      delete: 'Delete',
      open: 'Open',
      reveal: 'Show in folder',
      count: '{count} file(s)',
    }

    /** Interpolate `{name}` placeholders. */
    function format(template, params) {
      return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
        params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
      )
    }

    /** Same-origin call into the plugin's Host route. */
    async function callHost(action, body) {
      let response
      try {
        response = await fetch(`${ROUTE}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
      } catch (error) {
        throw new Error('unreachable')
      }
      if (!response.ok) throw new Error(`route ${response.status}`)
      const payload = await response.json()
      if (!payload || payload.ok === false) throw new Error(payload?.error ?? 'unknown error')
      return payload
    }

    /** The MIME type the saved extension implies, so a download keeps its kind. */
    function mimeFor(name) {
      return name.endsWith('.html') ? 'text/html' : name.endsWith('.json') ? 'application/json' : 'text/markdown'
    }

    /** Hand a rendered string to the browser as a file download. */
    function downloadText(name, text) {
      const blob = new Blob([text], { type: `${mimeFor(name)};charset=utf-8` })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    }

    /** Copy text with the best API the page offers. */
    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }

    /**
     * The action-row button, matching the row's existing icon buttons: a
     * 28px box, a 15px glyph, and the tertiary label colour that turns
     * secondary on hover. Hover is applied through handlers because the row
     * pins the size with `--dsh-content-font-delta` and neither a CSS file nor
     * a `:hover` rule is reachable from here.
     */
    const actionButtonStyle = {
      width: 'calc(28px + var(--dsh-content-font-delta, 0px))',
      height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
      borderRadius: 'var(--dsw-radius-sm)',
      color: 'var(--dsw-alias-label-tertiary)',
      cursor: 'pointer',
      background: 'transparent',
      border: 'none',
      padding: 6,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    }
    const actionButtonRest = { background: 'transparent', color: 'var(--dsw-alias-label-tertiary)' }
    const actionButtonHover = { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' }

    const styles = {
      // The dialog is a lot of controls; cap its height and scroll the body so
      // the platform footer (and its buttons) never leaves the viewport.
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        width: '100%',
        boxSizing: 'border-box',
        // Cap the body and scroll it internally: the platform Modal does not
        // constrain its children, so a tall dialog used to push its own footer
        // (and the 导出 button) out of the viewport.
        maxHeight: 'min(62vh, 540px)',
        overflowY: 'auto',
        overflowX: 'hidden',
      },
      summaryBox: { display: 'flex', flexDirection: 'column', gap: '3px' },
      grid2: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: '8px',
      },
      formatGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: '6px',
      },
      toggleGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '6px 14px',
      },
      choiceRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px' },
      slider: { width: '150px', maxWidth: '100%', accentColor: 'var(--dsw-alias-brand-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      cardChosen: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-l2)',
      },
      choices: { display: 'flex', flexDirection: 'column', gap: '8px' },
      choice: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        cursor: 'pointer',
        background: 'none',
        border: 'none',
        padding: 0,
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
      },
      radio: { marginTop: '3px', flex: 'none' },
      choiceText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      choiceTitle: { fontWeight: 500 },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xs-13)' },
      label: {
        fontSize: 'var(--dsw-font-xxs-12)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      toggles: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px' },
      toggle: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      footer: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
      summary: { color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--dsw-font-xs-13)' },
      errorText: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 'var(--dsw-font-xs-13)' },
      bannerOk: {
        padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 'var(--dsw-font-xs-13)',
        wordBreak: 'break-all',
      },
      bannerError: {
        padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 'var(--dsw-font-xs-13)',
        wordBreak: 'break-all',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--dsw-font-xs-13)' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      nameCell: {
        maxWidth: 340,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--dsh-font-family-code)',
      },
      scroll: { maxHeight: '52vh', overflow: 'auto' },
      input: {
        width: '100%',
        padding: '6px 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
      },
    }

    /**
     * The plugin body. `sessionId` arrives from the slot, so the dialog always
     * exports the conversation the button was clicked in.
     * @param {{ sessionId: string, t: (key: string, params?: Record<string, unknown>) => string, messageId?: string }} props
     */
    function ShareDialog(props) {
      const { sessionId, t } = props
      const [open, setOpen] = React.useState(false)
      const [formatId, setFormatId] = React.useState('markdown')
      const [scope, setScope] = React.useState('all')
      const [turns, setTurns] = React.useState(5)
      const [toolCalls, setToolCalls] = React.useState(true)
      const [toolResults, setToolResults] = React.useState(true)
      const [reasoning, setReasoning] = React.useState(false)
      const [timestamps, setTimestamps] = React.useState(false)
      const [redact, setRedact] = React.useState(true)
      const [save, setSave] = React.useState(true)
      const [info, setInfo] = React.useState({ status: 'idle' })
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [copied, setCopied] = React.useState(false)

      const requestFor = React.useCallback(
        () => ({
          sessionId,
          format: formatId,
          turns: scope === 'all' ? undefined : turns,
          toolCalls,
          toolResults,
          reasoning,
          timestamps,
          redact,
        }),
        [sessionId, formatId, scope, turns, toolCalls, toolResults, reasoning, timestamps, redact],
      )

      // Live summary: what would come out right now. Re-read on every change so
      // the size and the redaction count are never stale.
      React.useEffect(() => {
        if (!open) return undefined
        let live = true
        // The round slider fires on every tick, and each `prepare` re-renders
        // the whole document on the Host. Debounce so a drag costs one render
        // instead of dozens; the previous summary stays on screen meanwhile.
        const timer = setTimeout(() => {
          setInfo((previous) => ({ ...previous, status: 'loading' }))
          callHost('prepare', requestFor())
            .then((payload) => {
              if (live) setInfo({ status: 'ready', ...payload })
            })
            .catch((error) => {
              if (live) setInfo({ status: 'error', message: String(error.message) })
            })
        }, 180)
        return () => {
          live = false
          clearTimeout(timer)
        }
      }, [open, requestFor])

      const close = () => {
        setOpen(false)
        setCopied(false)
      }

      const runExport = async (mode) => {
        setBusy(true)
        try {
          const payload = await callHost('export', { ...requestFor(), save: mode === 'save' || save })
          const name = payload.saved?.name ?? `${payload.title || 'conversation'}.${payload.extension}`
          if (mode !== 'copy') downloadText(name, payload.content)
          if (mode === 'copy') {
            await copyText(payload.content)
            setCopied(true)
          }
          setResult({
            tone: 'success',
            text:
              mode === 'copy'
                ? t('copied')
                : payload.saved
                  ? t('saved', { name: payload.saved.name })
                  : t('downloaded', { name }),
          })
          if (payload.saved) setInfo((previous) => ({ ...previous, lastSaved: payload.saved }))
        } catch (error) {
          setResult({
            tone: 'error',
            text: String(error.message) === 'unreachable' ? t('routeError') : t('exportError', { message: error.message }),
          })
        } finally {
          setBusy(false)
        }
      }

      const summary =
        info.status === 'ready'
          ? t('summary', { messages: info.messages, rounds: info.rounds, size: info.size })
          : info.status === 'empty'
            ? t('empty')
            : ''

      return jsxs(React.Fragment, {
        children: [
          jsx(Tooltip, {
            label: t('actionTitle'),
            side: 'bottom',
            portal: true,
            children: jsx('button', {
              type: 'button',
              'aria-label': t('actionTitle'),
              title: t('actionTitle'),
              onClick: () => {
                setResult(null)
                setOpen(true)
              },
              className: 'dsh-share-action',
              style: actionButtonStyle,
              onMouseEnter: (event) => Object.assign(event.currentTarget.style, actionButtonHover),
              onMouseLeave: (event) => Object.assign(event.currentTarget.style, actionButtonRest),
              children: IconDownload ? jsx(IconDownload, { size: 15 }) : '⇩',
            }),
          }),
          jsx(Modal, {
            open,
            title: t('dialogTitle'),
            closeLabel: t('close'),
            onClose: close,
            className: 'dsh-share-modal',
            footer: jsxs('div', {
              style: styles.footer,
              children: [
                jsx(Button, { onClick: close, children: t('cancel') }),
                jsx(Button, {
                  variant: 'primary',
                  disabled: busy || info.status === 'loading',
                  onClick: () => runExport(save ? 'save' : 'download'),
                  children: busy ? t('exporting') : t('export'),
                }),
              ],
            }),
            children: jsxs('div', {
              style: styles.root,
              children: [
                jsxs('div', {
                  style: styles.summaryBox,
                  children: [
                    jsx('div', { style: styles.hint, children: t('dialogSubtitle') }),
                    jsx('div', {
                      style: info.status === 'error' ? styles.errorText : styles.summary,
                      children:
                        info.status === 'error'
                          ? t('loadError', { message: info.message })
                          : summary || (info.status === 'loading' ? t('loading') : ''),
                    }),
                  ],
                }),
                section(
                  t('format'),
                  [
                    cardChoice('markdown', formatId, setFormatId, t('formatMarkdown')),
                    cardChoice('html', formatId, setFormatId, t('formatHtml')),
                    cardChoice('json', formatId, setFormatId, t('formatJson')),
                  ],
                  'formatGrid',
                ),
                jsx('div', {
                  style: styles.hint,
                  children:
                    formatId === 'html'
                      ? t('formatHtmlHint')
                      : formatId === 'json'
                        ? t('formatJsonHint')
                        : t('formatMarkdownHint'),
                }),
                section(t('range'), [
                  choice('all', scope, setScope, t('whole')),
                  jsxs('div', {
                    style: styles.choiceRow,
                    children: [
                      jsxs('label', {
                        style: styles.choice,
                        children: [
                          jsx('input', {
                            type: 'radio',
                            name: 'share-scope-turns',
                            checked: scope === 'turns',
                            onChange: () => setScope('turns'),
                            style: styles.radio,
                          }),
                          jsx('span', { style: styles.choiceTitle, children: t('recent') }),
                        ],
                      }),
                      jsx('input', {
                        type: 'range',
                        min: 1,
                        max: Math.max(1, Number(info.status === 'ready' ? info.totalRounds : 10)),
                        value: turns,
                        onChange: (event) => {
                          setScope('turns')
                          setTurns(Number(event.target.value))
                        },
                        style: styles.slider,
                      }),
                      jsx('span', { style: styles.summary, children: t('turns', { count: turns }) }),
                    ],
                  }),
                ]),
                section(
                  t('content'),
                  [
                    toggle(t('toolCalls'), toolCalls, setToolCalls),
                    toggle(t('toolResults'), toolResults, setToolResults, !toolCalls),
                    toggle(t('reasoning'), reasoning, setReasoning),
                    toggle(t('timestamps'), timestamps, setTimestamps),
                  ],
                  'toggleGrid',
                ),
                jsxs('div', {
                  style: styles.grid2,
                  children: [
                    jsxs('div', {
                      style: styles.card,
                      children: [
                        toggle(t('redact'), redact, setRedact),
                        jsx('div', {
                          style: styles.hint,
                          children:
                            info.status === 'ready'
                              ? info.redactions > 0
                                ? t('redacted', { count: info.redactions })
                                : t('nothingRedacted')
                              : t('redactHint'),
                        }),
                      ],
                    }),
                    jsxs('div', {
                      style: styles.card,
                      children: [
                        toggle(t('save'), save, setSave),
                        jsx('div', {
                          style: styles.hint,
                          children: t('saveHint', { dir: info.exportDir ?? '' }),
                        }),
                      ],
                    }),
                  ],
                }),
                result
                  ? jsx('div', {
                      style: result.tone === 'error' ? styles.bannerError : styles.bannerOk,
                      children: result.text,
                    })
                  : null,
              ],
            }),
          }),
        ],
      })

      /** One labelled group of choices; `layout` picks the arrangement. */
      function section(title, children, layout) {
        return jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '8px' },
          children: [
            jsx('div', { style: styles.label, children: title }),
            jsx('div', { style: layout ? styles[layout] : styles.choices, children }),
          ],
        })
      }

      /** A format option as a compact selectable card: one row of three. */
      function cardChoice(value, current, setter, title) {
        const chosen = current === value
        return jsxs('label', {
          style: {
            ...styles.card,
            ...(chosen ? styles.cardChosen : null),
            padding: '7px 10px',
            cursor: 'pointer',
            flexDirection: 'row',
            alignItems: 'center',
            gap: '7px',
          },
          children: [
            jsx('input', {
              type: 'radio',
              name: 'share-format',
              checked: chosen,
              onChange: () => setter(value),
              style: styles.radio,
            }),
            jsx('span', { style: styles.choiceTitle, children: title }),
          ],
        })
      }

      /** One radio row with a title and an optional hint. */
      function choice(value, current, setter, title, hint) {
        return jsxs('label', {
          style: styles.choice,
          children: [
            jsx('input', {
              type: 'radio',
              name: `share-${title}`,
              checked: current === value,
              onChange: () => setter(value),
              style: styles.radio,
            }),
            jsxs('span', {
              style: styles.choiceText,
              children: [
                jsx('span', { style: styles.choiceTitle, children: title }),
                hint ? jsx('span', { style: styles.hint, children: hint }) : null,
              ],
            }),
          ],
        })
      }

      /** One checkbox row. */
      function toggle(title, value, setter, disabled) {
        return jsxs('label', {
          style: { ...styles.toggle, opacity: disabled ? 0.45 : 1 },
          children: [
            jsx('input', {
              type: 'checkbox',
              checked: value,
              disabled,
              onChange: (event) => setter(event.target.checked),
            }),
            jsx('span', { children: title }),
          ],
        })
      }
    }

    /** The export library: list, filter, reopen, delete saved files. */
    function ExportLibrary(props) {
      const { t } = props
      const [open, setOpen] = React.useState(false)
      const [files, setFiles] = React.useState([])
      const [dir, setDir] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)

      const refresh = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const payload = await callHost('list', {})
          setFiles(Array.isArray(payload.files) ? payload.files : [])
          setDir(payload.dir ?? '')
        } catch (problem) {
          setError(String(problem.message) === 'unreachable' ? t('routeError') : String(problem.message))
        } finally {
          setLoading(false)
        }
      }, [t])

      React.useEffect(() => {
        if (open) refresh()
      }, [open, refresh])

      const visible = files.filter((file) => filter.trim() === '' || file.name.toLowerCase().includes(filter.trim().toLowerCase()))

      const openFile = async (file) => {
        try {
          const payload = await callHost('read', { name: file.name })
          const anchor = document.createElement('a')
          const url = URL.createObjectURL(new Blob([payload.content], { type: `${mimeFor(file.name)};charset=utf-8` }))
          anchor.href = url
          anchor.target = '_blank'
          anchor.rel = 'noopener'
          // A detached anchor is still clickable for a download, but opening a
          // new tab from one is what popup blockers refuse; mounting it first
          // makes the preview window behave.
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 8000)
        } catch (problem) {
          setError(String(problem.message))
        }
      }

      const remove = async (file) => {
        if (!window.confirm(t('delete') + ' — ' + file.name)) return
        try {
          await callHost('delete', { name: file.name })
          await refresh()
        } catch (problem) {
          setError(String(problem.message))
        }
      }

      return jsxs(React.Fragment, {
        children: [
          jsx(Tooltip, {
            label: t('libraryAction'),
            side: 'bottom',
            portal: true,
            children: jsx('button', {
              type: 'button',
              'aria-label': t('libraryAction'),
              title: t('libraryAction'),
              onClick: () => setOpen(true),
              className: 'dsh-share-action',
              style: actionButtonStyle,
              onMouseEnter: (event) => Object.assign(event.currentTarget.style, actionButtonHover),
              onMouseLeave: (event) => Object.assign(event.currentTarget.style, actionButtonRest),
              children: IconLibrary ? jsx(IconLibrary, { size: 15 }) : '🗂',
            }),
          }),
          jsx(Modal, {
            open,
            title: t('libraryTitle'),
            closeLabel: t('close'),
            onClose: () => setOpen(false),
            className: 'dsh-share-modal dsh-share-modal--library',
            footer: jsxs('div', {
              style: styles.footer,
              children: [
                jsx(Button, { onClick: refresh, disabled: loading, children: t('refresh') }),
                jsx(Button, { variant: 'primary', onClick: () => setOpen(false), children: t('close') }),
              ],
            }),
            children: jsxs('div', {
              style: styles.root,
              children: [
                jsx('div', { style: styles.hint, children: t('librarySubtitle') }),
                dir ? jsx('div', { style: styles.summary, children: dir }) : null,
                jsxs('div', {
                  style: styles.row,
                  children: [
                    jsx('input', {
                      type: 'search',
                      placeholder: t('filter'),
                      value: filter,
                      onChange: (event) => setFilter(event.target.value),
                      style: styles.input,
                    }),
                    jsx('div', { style: styles.summary, children: t('count', { count: visible.length }) }),
                  ],
                }),
                error ? jsx('div', { style: { color: 'var(--dsw-alias-state-error-primary)' }, children: error }) : null,
                visible.length === 0
                  ? jsx('div', { style: styles.hint, children: loading ? t('loading') : t('libraryEmpty') })
                  : jsx('div', {
                      style: styles.scroll,
                      children: jsxs('table', {
                        style: styles.table,
                        children: [
                          jsx('thead', {
                            children: jsxs('tr', {
                              children: [
                                jsx('th', { style: styles.th, children: t('colName') }),
                                jsx('th', { style: styles.th, children: t('colSize') }),
                                jsx('th', { style: styles.th, children: t('colTime') }),
                                jsx('th', { style: styles.th, children: '' }),
                              ],
                            }),
                          }),
                          jsx('tbody', {
                            children: visible.map((file) =>
                              jsxs(
                                'tr',
                                {
                                  children: [
                                    jsx('td', { style: styles.td, children: jsx('span', { style: styles.nameCell, title: file.name, children: file.name }) }),
                                    jsx('td', { style: styles.td, children: file.size }),
                                    jsx('td', { style: styles.td, children: new Date(file.createdAt).toLocaleString() }),
                                    jsx('td', {
                                      style: { ...styles.td, whiteSpace: 'nowrap' },
                                      children: jsxs('span', {
                                        style: { display: 'inline-flex', gap: 6 },
                                        children: [
                                          jsx(Button, { onClick: () => openFile(file), children: t('open') }),
                                          jsx(Button, { onClick: () => remove(file), children: t('delete') }),
                                        ],
                                      }),
                                    }),
                                  ],
                                },
                                file.name,
                              ),
                            ),
                          }),
                        ],
                      }),
                    }),
              ],
            }),
          }),
        ],
      })
    }

    /**
     * Slot entry: the icon button in the message action row plus its dialog.
     * `sessionId` arrives from the standard session scope; `messageId` is the
     * owner prop the row passes to every entry it renders.
     * @param {{ sessionId?: string, messageId?: string, t: (key: string, params?: Record<string, unknown>) => string }} props
     */
    function MessageAction(props) {
      return jsx(ShareDialog, { sessionId: props.sessionId, messageId: props.messageId, t: props.t })
    }

    /**
     * Slot entry: the library button in the chat header.
     * @param {{ t: (key: string) => string }} props
     */
    function HeaderAction(props) {
      return jsx(ExportLibrary, { t: props.t })
    }

    return {
      name: 'session-share',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-transcript-export: dictionaries')

        // The platform Modal is 380px wide, which turns this dialog into a tall
        // narrow column. Widen it (and only it) from a stylesheet we own, since
        // the primitive owns the element the width lives on.
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-transcript-export'
          tag.textContent = `
            .dsh-share-modal { width: min(560px, 92vw) !important; max-width: min(560px, 92vw) !important; }
            .dsh-share-modal--library { width: min(720px, 94vw) !important; max-width: min(720px, 94vw) !important; }
          `
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-transcript-export: dialog width')

        // The per-reply affordance: same slot the Copy and Branch buttons live
        // in, so the button lines up with them. Scoped to the session: the slot
        // already hands every entry `sessionId` as a standard prop, and
        // `messageId` as an owner prop, so no `inject` is needed here (and a
        // duplicate prop would be refused by the slot assembler).
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.assistant-actions',
              id: 'session-share',
              order: 20,
              locale: NS,
            },
            MessageAction,
          ),
        )

        // The library lives in the conversation header, beside the session's
        // own chrome, because it is not about one message.
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'session-share-library',
              order: 40,
              locale: NS,
            },
            HeaderAction,
          ),
        )
      },
    }
  },
})
