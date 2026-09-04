// Colored file/folder icons for the tree — a curated subset of the
// material-icon-theme (MIT, © Material Extensions) icon set, see
// file-icons.generated.ts and NOTICE.md for provenance.
import { FILE_ICON_DATA } from "./file-icons.generated";

const EXTENSION_ICON: Readonly<Record<string, string>> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  rst: "markdown",
  py: "python",
  pyc: "python",
  pyi: "python",
  pyx: "python",
  pxd: "python",
  pxi: "python",
  sql: "database",
  sqlite: "database",
  db: "database",
  json: "json",
  jsonc: "json",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  svg: "svg",
  html: "html",
  htm: "html",
  txt: "document",
  log: "log",
  sh: "console",
  bash: "console",
  zsh: "console",
  fish: "console",
  csh: "console",
  ps1: "powershell",
  tsx: "react_ts",
  jsx: "react",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  css: "css",
  scss: "sass",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  pdf: "pdf",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  m4v: "video",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  rar: "zip",
  "7z": "zip",
  env: "tune",
  ini: "settings",
  cfg: "settings",
  conf: "settings",
  toml: "toml",
  pem: "key",
  key: "key",
  crt: "certificate",
  h: "c",
  c: "c",
  cpp: "cpp",
  hpp: "cpp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  java: "java",
  csv: "table",
};

const FILE_NAME_ICON: Readonly<Record<string, string>> = {
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  dockerfile: "docker",
  makefile: "makefile",
  "package.json": "nodejs",
  "package-lock.json": "nodejs",
  "tsconfig.json": "tsconfig",
  ".npmrc": "npm",
  ".editorconfig": "editorconfig",
  ".prettierrc": "prettier",
  ".pre-commit-config.yaml": "pre-commit",
  license: "license",
  "readme.md": "readme",
  readme: "readme",
  "changelog.md": "changelog",
};

// Kept exact-case: the office relies on CLAUDE.md specifically (not claude.md).
const EXACT_CASE_FILE_NAME_ICON: Readonly<Record<string, string>> = {
  "CLAUDE.md": "claude",
  "CLAUDE.local.md": "claude",
};

const FOLDER_NAME_ICON: Readonly<Record<string, string>> = {
  clients: "folder-client",
  knowledge: "folder-docs",
  notes: "folder-docs",
  docs: "folder-docs",
  projects: "folder-project",
  scripts: "folder-scripts",
  ui: "folder-ui",
  agents: "folder-robot",
  skills: "folder-skills",
  hooks: "folder-hook",
  templates: "folder-template",
  _archive: "folder-archive",
  archive: "folder-archive",
  commands: "folder-command",
  rules: "folder-rules",
  layouts: "folder-layout",
  components: "folder-components",
  tokens: "folder-keys",
};

export function fileIconSrc(name: string): string {
  const exact = EXACT_CASE_FILE_NAME_ICON[name];
  if (exact !== undefined) return FILE_ICON_DATA[exact];
  const lower = name.toLowerCase();
  const byName = FILE_NAME_ICON[lower];
  if (byName !== undefined) return FILE_ICON_DATA[byName];
  const dot = lower.lastIndexOf(".");
  const ext = dot <= 0 ? "" : lower.slice(dot + 1);
  const byExt = EXTENSION_ICON[ext];
  if (byExt !== undefined) return FILE_ICON_DATA[byExt];
  return FILE_ICON_DATA.file;
}

export function folderIconSrc(name: string, open: boolean): string {
  const base = FOLDER_NAME_ICON[name.toLowerCase()] ?? "folder";
  const key = open ? `${base}-open` : base;
  return FILE_ICON_DATA[key] ?? FILE_ICON_DATA[open ? "folder-open" : "folder"];
}

export function isMarkdownName(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
}
