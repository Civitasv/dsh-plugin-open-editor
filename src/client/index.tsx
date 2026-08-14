/**
 * Open-in-editor plugin — client half.
 *
 * Contributes one control to the session header's action row
 * (`conversation.session.header.actions`): a split trigger that opens the
 * current session's workspace directory in your editor.
 *
 * - The main part of the trigger opens the configured default editor
 *   (usually VS Code) with one click — the Codex-style fast path.
 * - The caret opens a picker listing every built-in editor plus the OS file
 *   manager; entries the host could not find on PATH render disabled.
 * - The workspace path comes from the session summary's `cwd` (the host
 *   always has it); the control hides itself when a session has none.
 * - All launching happens server-side through the plugin's HTTP route; the
 *   browser never needs shell access.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClientContext, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only imports pulling the header-action slot contract and the
// session/global standard-kit members into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { EditorCatalogResponse, OpenResponse } from '../shared/types.ts'

export const name = 'open-editor'

/** Required client services (fiber inject — waits for sessions/slots/locale). */
export const inject = ['sessions', 'slots', 'locale']

const LOCALE_NS = 'open-editor'
const CATALOG_URL = 'open-editor/editors'
const OPEN_URL = 'open-editor/open'
const STYLE_TAG = 'dsh-plugin-open-editor/action.css'

/**
 * Control styles. Injected once per materialization with the loader's
 * `data-plugin-css` contract so the client HMR driver can inventory/remove it.
 * Palette comes from DSH's --dsw-* design tokens, mirroring the in-tree
 * header actions (jobs / subagent catalog).
 */
const ACTION_CSS = `
.dsoe-root{position:relative;display:inline-flex;align-items:center}
.dsoe-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:4px;padding:3px 6px;font:inherit;font-size:12px;line-height:18px;display:inline-flex}
.dsoe-trigger:hover,.dsoe-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}
.dsoe-trigger[disabled]{cursor:default;opacity:.55}
.dsoe-trigger-main{padding-right:2px}
.dsoe-caret{display:inline-flex;align-items:center;padding:0 2px}
.dsoe-caret svg{transition:transform .12s}
.dsoe-caret-open svg{transform:rotate(180deg)}
.dsoe-label{margin-left:2px}
.dsoe-menu{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);min-width:210px;max-width:min(320px,calc(100vw - 32px));box-shadow:var(--dsw-shadow-lv3);border-radius:12px;flex-direction:column;gap:1px;margin:0;padding:4px;list-style:none;display:flex;position:absolute;top:calc(100% + 5px);left:0}
.dsoe-head{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:5px 8px 4px}
.dsoe-path{color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;padding:0 8px 6px;max-width:280px;overflow:hidden}
.dsoe-item{box-sizing:border-box;width:100%;min-height:32px;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font:inherit;font-size:13px;line-height:18px;cursor:pointer;background:0 0;border:0;text-align:left;display:flex}
.dsoe-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsoe-item:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.55}
.dsoe-item-label{flex:1;min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.dsoe-item-mark{flex:none;display:inline-flex;align-items:center}
.dsoe-item-missing{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsoe-sep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 8px;flex:none}
.dsoe-notice{box-sizing:border-box;width:100%;border-radius:8px;align-items:center;gap:6px;padding:6px 8px;font-size:12px;line-height:16px;display:flex}
.dsoe-notice-ok{color:var(--dsw-alias-state-success-primary)}
.dsoe-notice-error{color:var(--dsw-alias-state-error-primary)}
.dsoe-spinner{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);animation:dsoe-spin .8s linear infinite}
@keyframes dsoe-spin{to{transform:rotate(360deg)}}
`
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-open-editor'
  tag.dataset.pluginCss = STYLE_TAG
  tag.textContent = ACTION_CSS
  document.head.appendChild(tag)
}

/** Simplified Chinese dictionary (key-set source of truth). */
const zh = {
  'button.label': '在编辑器中打开',
  'button.aria': '在编辑器中打开当前项目（点击打开默认编辑器，点击箭头选择编辑器）',
  'menu.title': '打开当前项目',
  'menu.openDefault': '用默认编辑器打开',
  'notice.opened': '已用 {name} 打开',
  'notice.failed': '打开失败',
  'notice.editorMissing': '未找到 {name}，请检查是否安装并加入 PATH',
  'notice.noPath': '当前会话没有项目目录',
  'notice.busy': '正在打开…',
  'status.missing': '未安装',
  'status.default': '默认',
} as const

/** English dictionary, checked complete against the zh key set. */
const en: Record<keyof typeof zh, string> = {
  'button.label': 'Open in editor',
  'button.aria': 'Open the current project in an editor (click to open the default editor, click the arrow to choose)',
  'menu.title': 'Open current project',
  'menu.openDefault': 'Open with default editor',
  'notice.opened': 'Opened with {name}',
  'notice.failed': 'Failed to open',
  'notice.editorMissing': '{name} not found — is it installed and on PATH?',
  'notice.noPath': 'This session has no project directory',
  'notice.busy': 'Opening…',
  'status.missing': 'not installed',
  'status.default': 'default',
}

type OpenEditorActionProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'open-editor'>

interface Notice {
  kind: 'ok' | 'error'
  text: string
}

/** Folder-open icon (lucide). */
function IconFolderOpen() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

/** Chevron-down icon (lucide). */
function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** Check icon (lucide). */
function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/**
 * Session-header action: open the session's workspace in an editor.
 * Renders nothing while the session has no `cwd` (no workspace).
 */
function OpenEditorAction({ sessionId, useSessions, t }: OpenEditorActionProps) {
  const cwd = useSessions((s: SessionListState) => s.byId[sessionId]?.cwd)
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<EditorCatalogResponse | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Load the host-side editor catalog once (labels + availability).
  useEffect(() => {
    let alive = true
    void fetch(CATALOG_URL, { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<EditorCatalogResponse>) : null))
      .then((data) => {
        if (alive && data) setCatalog(data)
      })
      .catch(() => {
        // catalog is a nicety — the open route validates anyway
      })
    return () => {
      alive = false
    }
  }, [])

  // Close on outside pointer and Escape, like the other header popovers.
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnKey)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnKey)
    }
  }, [open])

  // Auto-dismiss transient notices.
  useEffect(() => {
    if (!notice) return
    noticeTimer.current = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(noticeTimer.current)
  }, [notice])

  const labelOf = (id: string) => catalog?.editors.find((e) => e.id === id)?.label ?? id
  const defaultEditor = catalog?.default
  const defaultLabel = defaultEditor ? labelOf(defaultEditor) : ''

  const openEditor = async (editor: string) => {
    if (!cwd) {
      setNotice({ kind: 'error', text: t('notice.noPath') })
      return
    }
    setBusyId(editor)
    setNotice(null)
    try {
      const res = await fetch(OPEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editor, path: cwd }),
      })
      const data = (await res.json().catch(() => null)) as OpenResponse | null
      if (res.ok && data?.ok) {
        setNotice({ kind: 'ok', text: t('notice.opened', { name: data.label }) })
      } else if (data && !data.ok && data.code === 'editor-not-found') {
        const name = data.error?.match(/^(.+?) is not installed/)?.[1] ?? editor
        setNotice({ kind: 'error', text: t('notice.editorMissing', { name }) })
      } else {
        setNotice({ kind: 'error', text: data && !data.ok ? data.error : t('notice.failed') })
      }
    } catch {
      setNotice({ kind: 'error', text: t('notice.failed') })
    } finally {
      setBusyId(null)
      setOpen(false)
    }
  }

  const editors = useMemo(() => catalog?.editors ?? [], [catalog])
  if (!cwd) return null

  const busy = busyId !== null

  return (
    <div ref={rootRef} className="dsoe-root">
      <button
        ref={triggerRef}
        type="button"
        className="dsoe-trigger"
        aria-label={t('button.aria')}
        disabled={busy}
        onClick={() => {
          if (defaultEditor) void openEditor(defaultEditor)
          else setOpen((v) => !v)
        }}
      >
        {busy ? <span className="dsoe-spinner" aria-hidden="true" /> : <IconFolderOpen />}
        <span className="dsoe-label">{busy ? t('notice.busy') : defaultLabel || t('button.label')}</span>
      </button>
      <button
        type="button"
        className={`dsoe-trigger dsoe-caret${open ? ' dsoe-caret-open' : ''}`}
        aria-label={t('menu.title')}
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <IconChevronDown />
      </button>
      {open ? (
        <ul className="dsoe-menu" role="menu" aria-label={t('menu.title')}>
          <li className="dsoe-head" role="presentation">{t('menu.title')}</li>
          <li className="dsoe-path" role="presentation" title={cwd}>{cwd}</li>
          {editors.map((editor, index) => {
            const isDefault = editor.id === defaultEditor
            const isFileManager = editor.id === 'explorer'
            return (
              <li key={editor.id} role="none">
                {isFileManager && index > 0 ? <div className="dsoe-sep" role="separator" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  className="dsoe-item"
                  disabled={!editor.available}
                  onClick={() => void openEditor(editor.id)}
                >
                  <span className="dsoe-item-mark">{isDefault ? <IconCheck /> : null}</span>
                  <span className="dsoe-item-label">{editor.label}</span>
                  {!editor.available ? (
                    <span className="dsoe-item-missing">{t('status.missing')}</span>
                  ) : isDefault ? (
                    <span className="dsoe-item-missing">{t('status.default')}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
          {notice ? (
            <li className={`dsoe-notice dsoe-notice-${notice.kind}`} role="status">
              {notice.text}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'open-editor: locale dictionary')
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'open-editor',
        order: 60,
        locale: LOCALE_NS,
      },
      OpenEditorAction,
    ),
  )
}
