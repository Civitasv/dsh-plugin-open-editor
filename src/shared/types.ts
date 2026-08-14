/**
 * Wire types shared by the server routes and the browser client.
 */

/** One picker row: label plus host-side availability probe result. */
export interface EditorStatus {
  id: string
  label: string
  /** Whether a launchable executable was found on the host. */
  available: boolean
  /** Whether the entry is a built-in (vs. a user-configured custom editor). */
  builtin: boolean
}

/** GET {statusPath} response: the full picker catalog. */
export interface EditorCatalogResponse {
  /** Editor used by the one-click trigger (config defaultEditor). */
  default: string
  editors: EditorStatus[]
}

/** POST {routePath} request body. */
export interface OpenRequest {
  /** Editor id; omitted/empty falls back to the configured default. */
  editor?: string
  /** Absolute path to open: a directory, or a file when `line` is targeted. */
  path: string
  /** Optional 1-based line to jump to (file opens use `--goto`-style flags). */
  line?: number
}

export type OpenResponse =
  | { ok: true; editor: string; label: string; bin: string; path: string }
  | { ok: false; error: string; code?: 'editor-not-found' | 'bad-path' | 'not-allowed' | 'invalid-json' }
