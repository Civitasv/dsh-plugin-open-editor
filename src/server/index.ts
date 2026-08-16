/**
 * Open-in-editor plugin — server half.
 *
 * Runs inside the DSH host process (the same machine as the browser), so it
 * can launch desktop editors directly:
 *
 * - `GET  {statusPath}`  — editor catalog with availability probes, so the
 *   browser picker can gray out editors that are not installed.
 * - `POST {routePath}`   — `{ editor?, path, line? }`; validates the path
 *   (absolute, existing file or directory, optional `allowedRoots` allowlist)
 *   and launches the editor detached. With `line`, editors that support line
 *   targeting open the file at that line (`--goto file:line` for the VS Code
 *   family, `file:line` for Sublime Text).
 *
 * Launch semantics:
 * - POSIX: `spawn(bin, args, { detached, stdio: 'ignore' })` and unref — the
 *   editor keeps running after the host exits.
 * - Windows: `cmd.exe /c start "" <bin> <args...>` — `start` detaches the app
 *   without creating a console window and returns immediately. `.cmd`/`.bat` shims (code.cmd,
 *   cursor.cmd …) work because cmd resolves them.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { allBuiltinEditors, DEFAULT_EDITOR, editorById, type EditorDef } from '../shared/editors.ts'
import type { EditorCatalogResponse, OpenResponse } from '../shared/types.ts'

export const name = 'open-editor'

/** A user-configured editor entry (cordis config). */
export interface CustomEditorConfig {
  /** Unique id (must not collide with a built-in editor id). */
  id: string
  /** Display label for the picker. */
  label: string
  /**
   * Full command template. `command[0]` is the executable (PATH name or
   * absolute path); a literal `{path}` element is replaced with the target
   * directory, otherwise the path is appended as the last argument.
   */
  command: string[]
}

export interface Config {
  /** HTTP route receiving open requests. */
  routePath: string
  /** HTTP route returning the editor catalog with availability. */
  statusPath: string
  /** Editor used by the one-click trigger and when a request omits `editor`. */
  defaultEditor: string
  /** Extra editors defined by the user. */
  customEditors: CustomEditorConfig[]
  /** Non-empty = only directories under these roots may be opened. */
  allowedRoots: string[]
  /** Extra CLI args passed to every built-in editor launch (after the editor, before the path). */
  extraArgs: string[]
}

export const Config: z<Config> = z.object({
  routePath: z.string().default('/open-editor/open'),
  statusPath: z.string().default('/open-editor/editors'),
  defaultEditor: z.string().default(DEFAULT_EDITOR),
  customEditors: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().default(''),
        command: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  allowedRoots: z.array(z.string()).default([]),
  extraArgs: z.array(z.string()).default([]),
})

/** Every editor known to this plugin instance: built-ins + configured customs. */
function allEditors(config: Config): EditorDef[] {
  const builtins = [...allBuiltinEditors()]
  const seen = new Set(builtins.map((e) => e.id))
  const customs: EditorDef[] = config.customEditors
    .filter((c) => !seen.has(c.id))
    .map((c) => ({
      id: c.id,
      label: c.label || c.id,
      bins: [c.command[0] ?? c.id],
    }))
  return [...builtins, ...customs]
}

function resolveEditor(config: Config, id: string): EditorDef | undefined {
  return allEditors(config).find((e) => e.id === id)
}

// ---------------------------------------------------------------------------
// Executable probing (cached briefly — availability does not change often).
// ---------------------------------------------------------------------------

interface ProbeRecord {
  bin: string | null
  at: number
}

const PROBE_TTL_MS = 60_000
const probeCache = new Map<string, ProbeRecord>()

function hasPathSeparator(bin: string): boolean {
  return bin.includes(sep) || bin.includes('/') || bin.includes('\\')
}

function inPath(bin: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    execFile(probe, [bin], { windowsHide: true }, (error) => resolve(!error))
  })
}

/** Resolve the first launchable executable for a definition, or null. */
async function findBin(def: EditorDef): Promise<string | null> {
  const candidates = [...def.bins, ...(process.platform === 'win32' ? (def.winBins ?? []) : [])]
  for (const bin of candidates) {
    const cached = probeCache.get(bin)
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      if (cached.bin !== null) return cached.bin
      continue
    }
    let found: string | null = null
    if (hasPathSeparator(bin) || /\.(exe|cmd|bat)$/i.test(bin)) {
      // Absolute or path-qualified candidate — probe the filesystem directly.
      found = existsSync(bin) ? bin : null
    } else if (await inPath(bin)) {
      found = bin
    }
    probeCache.set(bin, { bin: found, at: Date.now() })
    if (found !== null) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Path validation.
// ---------------------------------------------------------------------------

type PathResult = { path: string } | { error: string }

function validatePath(raw: unknown, allowedRoots: string[]): PathResult {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'missing "path"' }
  const p = raw.trim()
  if (!isAbsolute(p)) return { error: `path must be absolute: ${p}` }
  if (!existsSync(p)) return { error: `path does not exist: ${p}` }
  try {
    const stat = statSync(p)
    if (!stat.isDirectory() && !stat.isFile()) return { error: `path is neither a file nor a directory: ${p}` }
  } catch (e) {
    return { error: `cannot stat path: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (allowedRoots.length > 0) {
    const ok = allowedRoots.some((root) => {
      const r = root.replace(/[\\/]+$/, '')
      return p === r || p.startsWith(r + sep)
    })
    if (!ok) return { error: `path is outside allowedRoots: ${p}` }
  }
  return { path: p }
}

// ---------------------------------------------------------------------------
// Launch.
// ---------------------------------------------------------------------------

/**
 * Launch `bin` with the complete `args` list and return immediately. The
 * child is detached and unref'd, so the host process never waits on the
 * editor.
 *
 * On Windows the invocation goes through `cmd /c start "" <bin> <args…>`:
 * `start` detaches the app without creating a console window and returns
 * right away, and cmd resolves
 * `.cmd`/`.bat` shims (code.cmd, cursor.cmd …). Arguments are passed raw —
 * Node's CreateProcess quoting wraps any token containing spaces in quotes,
 * producing exactly the canonical `start` form (`""` = empty window title;
 * `"C:\path with spaces"` = one argument). No manual quoting, so no nested
 * quotes to break cmd's re-parsing.
 */
function launch(bin: string, args: string[]): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', bin, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } else {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.unref()
  }
}

/**
 * Build the final argument list for a launch.
 *
 * - Custom editors: the command template wins; a literal `{path}` element is
 *   replaced with the target, a literal `{line}` with the line number when
 *   present (otherwise the line is ignored).
 * - Built-ins: `extraArgs` + the target. With a file `line`, the editor's
 *   `lineStrategy` produces the target form (`--goto file:line`,
 *   `file:line`); editors without a strategy open the file
 *   without a line.
 */
function buildArgs(config: Config, def: EditorDef, path: string, line?: number): string[] {
  const custom = config.customEditors.find((c) => c.id === def.id)
  if (custom) {
    const template = custom.command.length > 0 ? custom.command : [def.bins[0] ?? def.id]
    const rest = template.slice(1)
    const hasPath = rest.includes('{path}')
    const hasLine = rest.includes('{line}')
    const args = rest.map((a) => (a === '{path}' ? path : a === '{line}' ? String(line ?? '') : a))
    if (!hasPath) args.push(path)
    if (line !== undefined && !hasLine) {
      // No {line} slot in the template — line targeting unsupported; open the file only.
    }
    return args
  }
  if (line !== undefined && def.lineStrategy) {
    if (def.lineStrategy === 'vscode') return [...config.extraArgs, '--goto', `${path}:${line}`]
    return [...config.extraArgs, `${path}:${line}`] // sublime
  }
  return [...config.extraArgs, path]
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

function jsonResponse(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) body += chunk
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

async function buildCatalog(config: Config): Promise<EditorCatalogResponse> {
  const editors = await Promise.all(
    allEditors(config).map(async (def) => {
      const bin = await findBin(def)
      return { id: def.id, label: def.label, available: bin !== null, builtin: editorById(def.id) !== undefined }
    }),
  )
  const defaultId = resolveEditor(config, config.defaultEditor) ? config.defaultEditor : DEFAULT_EDITOR
  return { default: defaultId, editors }
}

async function handleOpen(config: Config, raw: unknown): Promise<{ status: number; body: OpenResponse }> {
  if (raw === null) return { status: 400, body: { ok: false, error: 'invalid JSON body', code: 'invalid-json' } }
  const record = isRecord(raw) ? raw : {}
  const pathResult = validatePath(record.path, config.allowedRoots)
  if ('error' in pathResult) return { status: 400, body: { ok: false, error: pathResult.error, code: 'bad-path' } }

  const line = record.line
  if (line !== undefined && line !== null && (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > 1_000_000_000)) {
    return { status: 400, body: { ok: false, error: 'invalid "line": positive integer expected' } }
  }

  const requested = typeof record.editor === 'string' && record.editor.trim() ? record.editor.trim() : config.defaultEditor
  const def = resolveEditor(config, requested)
  if (!def) return { status: 400, body: { ok: false, error: `unknown editor: ${requested}` } }

  const bin = await findBin(def)
  if (bin === null) {
    return {
      status: 404,
      body: { ok: false, error: `${def.label} is not installed or not on PATH`, code: 'editor-not-found' },
    }
  }

  const args = buildArgs(config, def, pathResult.path, line ?? undefined)
  launch(bin, args)
  return { status: 200, body: { ok: true, editor: def.id, label: def.label, bin, path: pathResult.path } }
}

/** Plugin body: register the catalog and open routes. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () =>
        httpCtx.webServer!.register({
          kind: 'exact',
          path: config.statusPath,
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              jsonResponse(res, 200, await buildCatalog(config))
              return
            }
            jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
          },
        }),
      'open-editor: catalog route',
    )
    httpCtx.effect(
      () =>
        httpCtx.webServer!.register({
          kind: 'exact',
          path: config.routePath,
          handler: async (req, res) => {
            if (req.method === 'POST') {
              const raw = await readJsonBody(req)
              const result = await handleOpen(config, raw)
              jsonResponse(res, result.status, result.body)
              return
            }
            jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
          },
        }),
      'open-editor: open route',
    )
  })
}
