// src/server/index.ts
import z from "@deepseek-ai/schemastery";
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

// src/shared/editors.ts
var DEFAULT_EDITOR = "vscode";
var EDITORS = [
  { id: "vscode", label: "VS Code", bins: ["code"] },
  { id: "vscode-insiders", label: "VS Code Insiders", bins: ["code-insiders"] },
  { id: "cursor", label: "Cursor", bins: ["cursor"] },
  { id: "windsurf", label: "Windsurf", bins: ["windsurf"] },
  { id: "trae", label: "Trae", bins: ["trae"] },
  { id: "intellij", label: "IntelliJ IDEA", bins: ["idea", "idea64"] },
  { id: "pycharm", label: "PyCharm", bins: ["pycharm", "charm"] },
  { id: "webstorm", label: "WebStorm", bins: ["webstorm"] },
  { id: "goland", label: "GoLand", bins: ["goland"] },
  { id: "clion", label: "CLion", bins: ["clion"] },
  { id: "rider", label: "Rider", bins: ["rider"] },
  { id: "phpstorm", label: "PhpStorm", bins: ["phpstorm"] },
  { id: "rubymine", label: "RubyMine", bins: ["rubymine"] },
  { id: "sublime", label: "Sublime Text", bins: ["subl"] },
  { id: "notepadpp", label: "Notepad++", bins: ["notepad++"] },
  { id: "vim", label: "Vim", bins: ["vim", "gvim"] },
  { id: "nvim", label: "Neovim", bins: ["nvim"] },
  { id: "emacs", label: "Emacs", bins: ["emacs"] }
];
function fileManagerDef() {
  const platform = process.platform;
  if (platform === "darwin") return { id: "explorer", label: "Finder", bins: ["open"] };
  if (platform === "win32") return { id: "explorer", label: "File Explorer", bins: ["explorer"] };
  return { id: "explorer", label: "File Manager", bins: ["xdg-open"] };
}
function editorById(id) {
  return EDITORS.find((e) => e.id === id);
}
function allBuiltinEditors() {
  return [...EDITORS, fileManagerDef()];
}

// src/server/index.ts
var name = "open-editor";
var Config = z.object({
  routePath: z.string().default("/open-editor/open"),
  statusPath: z.string().default("/open-editor/editors"),
  defaultEditor: z.string().default(DEFAULT_EDITOR),
  customEditors: z.array(
    z.object({
      id: z.string(),
      label: z.string().default(""),
      command: z.array(z.string()).default([])
    })
  ).default([]),
  allowedRoots: z.array(z.string()).default([]),
  extraArgs: z.array(z.string()).default([])
});
function allEditors(config) {
  const builtins = [...allBuiltinEditors()];
  const seen = new Set(builtins.map((e) => e.id));
  const customs = config.customEditors.filter((c) => !seen.has(c.id)).map((c) => ({
    id: c.id,
    label: c.label || c.id,
    bins: [c.command[0] ?? c.id]
  }));
  return [...builtins, ...customs];
}
function resolveEditor(config, id) {
  return allEditors(config).find((e) => e.id === id);
}
var PROBE_TTL_MS = 6e4;
var probeCache = /* @__PURE__ */ new Map();
function hasPathSeparator(bin) {
  return bin.includes(sep) || bin.includes("/") || bin.includes("\\");
}
function inPath(bin) {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(probe, [bin], { windowsHide: true }, (error) => resolve(!error));
  });
}
async function findBin(def) {
  const candidates = [...def.bins, ...process.platform === "win32" ? def.winBins ?? [] : []];
  for (const bin of candidates) {
    const cached = probeCache.get(bin);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      if (cached.bin !== null) return cached.bin;
      continue;
    }
    let found = null;
    if (hasPathSeparator(bin) || /\.(exe|cmd|bat)$/i.test(bin)) {
      found = existsSync(bin) ? bin : null;
    } else if (await inPath(bin)) {
      found = bin;
    }
    probeCache.set(bin, { bin: found, at: Date.now() });
    if (found !== null) return found;
  }
  return null;
}
function validatePath(raw, allowedRoots) {
  if (typeof raw !== "string" || !raw.trim()) return { error: 'missing "path"' };
  const p = raw.trim();
  if (!isAbsolute(p)) return { error: `path must be absolute: ${p}` };
  if (!existsSync(p)) return { error: `path does not exist: ${p}` };
  try {
    if (!statSync(p).isDirectory()) return { error: `path is not a directory: ${p}` };
  } catch (e) {
    return { error: `cannot stat path: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (allowedRoots.length > 0) {
    const ok = allowedRoots.some((root) => {
      const r = root.replace(/[\\/]+$/, "");
      return p === r || p.startsWith(r + sep);
    });
    if (!ok) return { error: `path is outside allowedRoots: ${p}` };
  }
  return { path: p };
}
function launch(bin, args) {
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", bin, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } else {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
}
function buildArgs(config, def, path) {
  const custom = config.customEditors.find((c) => c.id === def.id);
  if (custom) {
    const template = custom.command.length > 0 ? custom.command : [def.bins[0] ?? def.id];
    const rest = template.slice(1);
    return rest.includes("{path}") ? rest.map((a) => a === "{path}" ? path : a) : [...rest, path];
  }
  return [...config.extraArgs, path];
}
function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
async function buildCatalog(config) {
  const editors = await Promise.all(
    allEditors(config).map(async (def) => {
      const bin = await findBin(def);
      return { id: def.id, label: def.label, available: bin !== null, builtin: editorById(def.id) !== void 0 };
    })
  );
  const defaultId = resolveEditor(config, config.defaultEditor) ? config.defaultEditor : DEFAULT_EDITOR;
  return { default: defaultId, editors };
}
async function handleOpen(config, raw) {
  if (raw === null) return { status: 400, body: { ok: false, error: "invalid JSON body", code: "invalid-json" } };
  const record = isRecord(raw) ? raw : {};
  const pathResult = validatePath(record.path, config.allowedRoots);
  if ("error" in pathResult) return { status: 400, body: { ok: false, error: pathResult.error, code: "bad-path" } };
  const requested = typeof record.editor === "string" && record.editor.trim() ? record.editor.trim() : config.defaultEditor;
  const def = resolveEditor(config, requested);
  if (!def) return { status: 400, body: { ok: false, error: `unknown editor: ${requested}` } };
  const bin = await findBin(def);
  if (bin === null) {
    return {
      status: 404,
      body: { ok: false, error: `${def.label} is not installed or not on PATH`, code: "editor-not-found" }
    };
  }
  const args = buildArgs(config, def, pathResult.path);
  launch(bin, args);
  return { status: 200, body: { ok: true, editor: def.id, label: def.label, bin, path: pathResult.path } };
}
function apply(ctx, config) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: "exact",
        path: config.statusPath,
        handler: async (req, res) => {
          if (req.method === "GET" || req.method === "HEAD") {
            jsonResponse(res, 200, await buildCatalog(config));
            return;
          }
          jsonResponse(res, 405, { ok: false, error: "method not allowed" });
        }
      }),
      "open-editor: catalog route"
    );
    httpCtx.effect(
      () => httpCtx.webServer.register({
        kind: "exact",
        path: config.routePath,
        handler: async (req, res) => {
          if (req.method === "POST") {
            const raw = await readJsonBody(req);
            const result = await handleOpen(config, raw);
            jsonResponse(res, result.status, result.body);
            return;
          }
          jsonResponse(res, 405, { ok: false, error: "method not allowed" });
        }
      }),
      "open-editor: open route"
    );
  });
}
export {
  Config,
  apply,
  name
};
//# sourceMappingURL=index.js.map
