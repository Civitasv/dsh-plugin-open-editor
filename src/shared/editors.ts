/**
 * Shared editor catalog for dsh-plugin-open-editor.
 *
 * The server resolves a launchable executable per editor (PATH probe plus
 * platform candidates), the client renders the catalog returned by the
 * server route (labels and availability come from the host, so the picker
 * always reflects what is actually installed). Keeping the definitions in
 * one shared module means the two halves can never drift apart.
 */

export interface EditorDef {
  /** Stable id used on the wire, in config and in the picker. */
  id: string
  /** Display label shown in the picker (product name, not localized). */
  label: string
  /** Executable candidates in preference order (PATH names). */
  bins: string[]
  /** Windows-only extra candidates (absolute paths, .exe / .cmd / .bat). */
  winBins?: string[]
  /**
   * How to build the launch arguments when opening a FILE at a line.
   * Absent = open the file without a line target.
   */
  lineStrategy?: 'vscode' | 'plus' | 'sublime'
}

export const DEFAULT_EDITOR = 'vscode'

export const EDITORS: readonly EditorDef[] = [
  { id: 'vscode', label: 'VS Code', bins: ['code'], lineStrategy: 'vscode' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', bins: ['code-insiders'], lineStrategy: 'vscode' },
  { id: 'cursor', label: 'Cursor', bins: ['cursor'], lineStrategy: 'vscode' },
  { id: 'windsurf', label: 'Windsurf', bins: ['windsurf'], lineStrategy: 'vscode' },
  { id: 'trae', label: 'Trae', bins: ['trae'], lineStrategy: 'vscode' },
  { id: 'intellij', label: 'IntelliJ IDEA', bins: ['idea', 'idea64'] },
  { id: 'pycharm', label: 'PyCharm', bins: ['pycharm', 'charm'] },
  { id: 'webstorm', label: 'WebStorm', bins: ['webstorm'] },
  { id: 'goland', label: 'GoLand', bins: ['goland'] },
  { id: 'clion', label: 'CLion', bins: ['clion'] },
  { id: 'rider', label: 'Rider', bins: ['rider'] },
  { id: 'phpstorm', label: 'PhpStorm', bins: ['phpstorm'] },
  { id: 'rubymine', label: 'RubyMine', bins: ['rubymine'] },
  { id: 'sublime', label: 'Sublime Text', bins: ['subl'], lineStrategy: 'sublime' },
  { id: 'notepadpp', label: 'Notepad++', bins: ['notepad++'] },
  { id: 'vim', label: 'Vim', bins: ['vim', 'gvim'], lineStrategy: 'plus' },
  { id: 'nvim', label: 'Neovim', bins: ['nvim'], lineStrategy: 'plus' },
  { id: 'emacs', label: 'Emacs', bins: ['emacs'], lineStrategy: 'plus' },
]

/**
 * The OS file-manager pseudo-entry (opened like an editor; it is not one).
 * Label is platform-specific, so it is produced by the server's catalog
 * builder rather than living in the static table above.
 */
export function fileManagerDef(): EditorDef {
  const platform = process.platform
  if (platform === 'darwin') return { id: 'explorer', label: 'Finder', bins: ['open'] }
  if (platform === 'win32') return { id: 'explorer', label: 'File Explorer', bins: ['explorer'] }
  return { id: 'explorer', label: 'File Manager', bins: ['xdg-open'] }
}

export function editorById(id: string): EditorDef | undefined {
  return EDITORS.find((e) => e.id === id)
}

/** Every built-in editor plus the file-manager entry, in display order. */
export function allBuiltinEditors(): readonly EditorDef[] {
  return [...EDITORS, fileManagerDef()]
}
