/**
 * Zero-UI smoke test for the Windows launch mechanics used by
 * dsh-plugin-open-editor: `cmd /c start "" <bin> <args…>` with detached
 * spawn + unref, args passed raw so Node's CreateProcess quoting handles
 * spaces. The target is PowerShell (a real program), so the test proves
 * `start` forwards a directory argument containing spaces as ONE argument —
 * the exact shape used to open a project folder in an editor.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const spacedDir = join(root, 'dir with spaces')
mkdirSync(spacedDir, { recursive: true })
const marker = join(spacedDir, '.launch-test-marker.txt')
rmSync(marker, { force: true })

function launch(bin, args) {
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

// PowerShell writes the marker into the spaced directory. The whole
// -Command payload is one argument; Node quotes it (it contains spaces),
// and `start` forwards it to powershell verbatim.
const payload = `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value ok`
launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', payload])

const deadline = Date.now() + 8000
while (Date.now() < deadline) {
  if (existsSync(marker)) break
  await new Promise((r) => setTimeout(r, 150))
}

if (existsSync(marker)) {
  console.log('LAUNCH-OK: detached `cmd /c start` forwarded a spaced path arg to the target')
  rmSync(marker, { force: true })
  rmSync(spacedDir, { recursive: true, force: true })
  process.exit(0)
} else {
  console.error('LAUNCH-FAIL: marker never appeared')
  process.exit(1)
}
