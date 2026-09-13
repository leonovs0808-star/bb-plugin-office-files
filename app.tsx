// bb-plugin-office-files — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled),
// so this file must be loaded by BB, not imported directly.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { definePluginApp, Markdown, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Entry, ReadResult, SearchResult } from "./contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { fileIconSrc, folderIconSrc, isMarkdownName } from "@/lib/file-icons";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** Last segment of an absolute path — the file's own name. */
function fileName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Parent directory of an absolute path (root's own parent stays "/"). */
function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

async function copyToClipboard(value: string, successLabel: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(successLabel, { description: value });
  } catch {
    toast.error("Не удалось скопировать — буфер обмена недоступен");
  }
}

function CopyButton({
  value,
  icon,
  title,
  successLabel,
  className,
}: {
  value: string;
  icon: "Copy" | "Folder";
  title: string;
  successLabel: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(event) => {
        event.stopPropagation();
        void copyToClipboard(value, successLabel);
      }}
      className={cn(
        "shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function CopyPathButton({ path, className }: { path: string; className?: string }) {
  return (
    <CopyButton
      value={path}
      icon="Copy"
      title="Скопировать путь"
      successLabel="Путь скопирован"
      className={className}
    />
  );
}

function CopyFolderButton({ path, className }: { path: string; className?: string }) {
  return (
    <CopyButton
      value={parentDir(path)}
      icon="Folder"
      title="Скопировать путь к папке"
      successLabel="Путь к папке скопирован"
      className={className}
    />
  );
}

/** Same-origin URL of this plugin's streaming download route (see server.ts). */
function downloadUrl(path: string): string {
  return `/api/v1/plugins/office-files/http/download?path=${encodeURIComponent(path)}`;
}

/**
 * A real anchor, not a button: the browser then owns the transfer (progress,
 * resume, save dialog) and the bytes never pass through this component — which
 * is why a 200 MB video downloads the same way a 2 KB note does.
 */
function DownloadButton({
  path,
  name,
  className,
}: {
  path: string;
  name: string;
  className?: string;
}) {
  const title = "Скачать файл";
  return (
    <a
      href={downloadUrl(path)}
      download={name}
      title={title}
      aria-label={title}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      <Icon name="Download" className="size-3.5" />
    </a>
  );
}

/** Puts the file's path into the thread's own draft — the panel owns the composer handle. */
function InsertPathButton({
  path,
  onInsert,
  className,
}: {
  path: string;
  onInsert: (path: string) => void;
  className?: string;
}) {
  const title = "Вставить путь в сообщение";
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(event) => {
        event.stopPropagation();
        onInsert(path);
      }}
      className={cn(
        "shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      <Icon name="MessageSquarePlus" className="size-3.5" />
    </button>
  );
}

/** Picks a colored file/folder icon (material-icon-theme) — reads faster by shape than by name. */
function entryIconSrc(entry: Entry, open: boolean): string {
  return entry.kind === "directory" ? folderIconSrc(entry.name, open) : fileIconSrc(entry.name);
}

/** One directory's children, keyed by absolute path, cached once fetched. */
function useDirCache(rpc: Rpc) {
  const [byPath, setByPath] = useState<
    Map<string, { entries: Entry[]; error: string | null }>
  >(new Map());
  const [rootPath, setRootPath] = useState<string | null>(null);

  const load = useCallback(
    (path: string | undefined) => {
      rpc.call("files_list", path === undefined ? {} : { path }).then(
        (result) => {
          setRootPath(result.rootPath);
          setByPath((prev) => {
            const next = new Map(prev);
            next.set(result.path, { entries: result.entries, error: null });
            return next;
          });
        },
        (cause: unknown) => {
          const key = path ?? "__root__";
          setByPath((prev) => {
            const next = new Map(prev);
            next.set(key, {
              entries: [],
              error: cause instanceof Error ? cause.message : String(cause),
            });
            return next;
          });
        },
      );
    },
    [rpc],
  );

  return { byPath, rootPath, load };
}

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function TreeNode({
  entry,
  depth,
  byPath,
  load,
  selectedPath,
  onSelectFile,
  onInsertPath,
}: {
  entry: Entry;
  depth: number;
  byPath: Map<string, { entries: Entry[]; error: string | null }>;
  load: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onInsertPath: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const dir = entry.kind === "directory" ? byPath.get(entry.path) : undefined;

  const toggle = () => {
    if (entry.kind === "file") {
      onSelectFile(entry.path);
      return;
    }
    if (!open && dir === undefined) load(entry.path);
    setOpen((value) => !value);
  };

  return (
    <div>
      <div
        className={cn(
          "group flex w-full items-center gap-1 rounded pr-1 hover:bg-accent",
          selectedPath === entry.path && "bg-accent",
        )}
      >
        <button
          type="button"
          onClick={toggle}
          title={entry.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm"
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          {entry.kind === "directory" ? (
            <Icon
              name={open ? "ChevronDown" : "ChevronRight"}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          <img
            src={entryIconSrc(entry, open)}
            alt=""
            aria-hidden="true"
            className="size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {entry.kind === "file" ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {sizeLabel(entry.sizeBytes)}
            </span>
          ) : null}
        </button>
        <CopyPathButton
          path={entry.path}
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        />
        {entry.kind === "file" ? (
          <>
            <CopyFolderButton
              path={entry.path}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            />
            <DownloadButton
              path={entry.path}
              name={entry.name}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            />
            <InsertPathButton
              path={entry.path}
              onInsert={onInsertPath}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            />
          </>
        ) : null}
      </div>
      {entry.kind === "directory" && open ? (
        dir === undefined ? (
          <p
            className="py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
          >
            Загрузка…
          </p>
        ) : dir.error !== null ? (
          <p
            className="py-1 text-xs text-destructive"
            style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
          >
            {dir.error}
          </p>
        ) : dir.entries.length === 0 ? (
          <p
            className="py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
          >
            Пусто
          </p>
        ) : (
          dir.entries.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              byPath={byPath}
              load={load}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              onInsertPath={onInsertPath}
            />
          ))
        )
      ) : null}
    </div>
  );
}

/** One search hit: name plus the folder it sits in, relative to the office root. */
function SearchRow({
  entry,
  rootPath,
  selectedPath,
  onSelectFile,
  onInsertPath,
}: {
  entry: Entry;
  rootPath: string | null;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onInsertPath: (path: string) => void;
}) {
  const relative =
    rootPath !== null && entry.path.startsWith(`${rootPath}/`)
      ? entry.path.slice(rootPath.length + 1)
      : entry.path;
  const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1 rounded pr-1 hover:bg-accent",
        selectedPath === entry.path && "bg-accent",
      )}
    >
      <button
        type="button"
        title={entry.path}
        onClick={() => {
          if (entry.kind === "file") onSelectFile(entry.path);
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left text-sm"
      >
        <img
          src={entryIconSrc(entry, false)}
          alt=""
          aria-hidden="true"
          className="size-4 shrink-0"
        />
        <span className="shrink-0 truncate">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{folder}</span>
        {entry.kind === "file" ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {sizeLabel(entry.sizeBytes)}
          </span>
        ) : null}
      </button>
      <CopyPathButton
        path={entry.path}
        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      />
      {entry.kind === "file" ? (
        <>
          <DownloadButton
            path={entry.path}
            name={entry.name}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          />
          <InsertPathButton
            path={entry.path}
            onInsert={onInsertPath}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </>
      ) : null}
    </div>
  );
}

function FilePreview({
  path,
  result,
  onSaved,
  onInsertPath,
  rpc,
}: {
  path: string;
  result: ReadResult;
  onSaved: (content: string) => void;
  onInsertPath: (path: string) => void;
  rpc: Rpc;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Selecting a different file (new `result` object identity) always lands back in view mode.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
  }, [result]);

  const startEdit = () => {
    if (result.kind !== "text") return;
    setDraft(result.content);
    setSaveError(null);
    setEditing(true);
  };

  const save = () => {
    setSaving(true);
    setSaveError(null);
    rpc.call("files_write", { path, content: draft }).then(
      () => {
        setSaving(false);
        setEditing(false);
        onSaved(draft);
      },
      (cause: unknown) => {
        setSaving(false);
        setSaveError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {path}
        </span>
        <CopyPathButton path={path} />
        <CopyFolderButton path={path} />
        {editing ? null : <DownloadButton path={path} name={fileName(path)} />}
        {editing ? null : <InsertPathButton path={path} onInsert={onInsertPath} />}
        {result.kind === "text" && !editing ? (
          <Button variant="ghost" size="sm" onClick={startEdit} className="h-7 gap-1.5 px-2">
            <Icon name="Edit" className="size-3.5" />
            Редактировать
          </Button>
        ) : null}
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Отмена
            </Button>
            <Button
              size="sm"
              className="h-7 px-2"
              disabled={saving || draft === (result.kind === "text" ? result.content : "")}
              onClick={save}
            >
              {saving ? "Сохраняю…" : "Сохранить"}
            </Button>
          </>
        ) : null}
      </div>
      {saveError !== null ? (
        <p className="shrink-0 border-b border-border px-3 py-2 text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-xs outline-none"
          />
        ) : result.kind === "text" ? (
          isMarkdownName(path) ? (
            <div className="min-w-0 max-w-full p-3 [overflow-wrap:anywhere]">
              <Markdown content={result.content} />
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs">
              {result.content}
            </pre>
          )
        ) : result.kind === "image" ? (
          <div className="p-3">
            <img
              src={`data:${result.mimeType};base64,${result.base64}`}
              alt={path}
              className="max-w-full rounded border border-border"
            />
          </div>
        ) : result.kind === "binary" ? (
          <p className="p-3 text-sm text-muted-foreground">
            Бинарный файл ({sizeLabel(result.sizeBytes)}) — предпросмотр недоступен.
          </p>
        ) : (
          <p className="p-3 text-sm text-muted-foreground">
            Файл слишком большой для предпросмотра ({sizeLabel(result.sizeBytes)}).
          </p>
        )}
      </div>
    </div>
  );
}

/** The panel component opened by the "Файлы офиса" thread panel action. */
function OfficeFilesPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { byPath, rootPath, load } = useDirCache(rpc);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReadResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Two characters is the floor: one letter matches most of the office and the
  // walk would be pure noise.
  const trimmedQuery = query.trim();
  const searchActive = trimmedQuery.length >= 2;

  useEffect(() => {
    if (!searchActive) {
      setSearch(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("files_search", { query: trimmedQuery }).then(
        (result) => {
          if (cancelled) return;
          setSearch(result);
          setSearching(false);
          setSearchError(null);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setSearching(false);
          setSearchError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }, 250); // typing settles before the office machine starts walking directories
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery, searchActive, rpc]);

  const insertPath = useCallback(
    (path: string) => {
      composer.updateText((current) => {
        const base = current.trimEnd();
        return base === "" ? path : `${base} ${path}`;
      });
      composer.focus();
      toast.success("Путь вставлен в сообщение", { description: path });
    },
    [composer],
  );

  useEffect(() => {
    load(undefined);
    // Runs once on mount; `load` is stable for the lifetime of this rpc instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rootError = byPath.get("__root__")?.error ?? null;
  const rootEntries = rootPath !== null ? byPath.get(rootPath)?.entries : undefined;

  const selectFile = (path: string) => {
    setSelectedPath(path);
    setPreview(null);
    setPreviewError(null);
    rpc.call("files_read", { path }).then(setPreview, (cause: unknown) => {
      setPreviewError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(220px,320px)_1fr]">
      <div className="flex min-h-0 flex-col border-r border-border">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
          <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по имени"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query !== "" ? (
            <button
              type="button"
              title="Очистить поиск"
              aria-label="Очистить поиск"
              onClick={() => setQuery("")}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            >
              <Icon name="X" className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {searchActive ? (
            searchError !== null ? (
              <p className="p-2 text-sm text-destructive">{searchError}</p>
            ) : searching ? (
              <p className="p-2 text-sm text-muted-foreground">Ищу…</p>
            ) : search === null ? null : search.matches.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">Ничего не нашёл</p>
            ) : (
              <>
                {search.matches.map((entry) => (
                  <SearchRow
                    key={entry.path}
                    entry={entry}
                    rootPath={rootPath}
                    selectedPath={selectedPath}
                    onSelectFile={selectFile}
                    onInsertPath={insertPath}
                  />
                ))}
                {search.truncated ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    Показаны первые {search.matches.length} — уточни запрос
                  </p>
                ) : null}
              </>
            )
          ) : rootError !== null ? (
            <p className="p-2 text-sm text-destructive">{rootError}</p>
          ) : rootEntries === undefined ? (
            <p className="p-2 text-sm text-muted-foreground">Загрузка офиса…</p>
          ) : (
            rootEntries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                byPath={byPath}
                load={load}
                selectedPath={selectedPath}
                onSelectFile={selectFile}
                onInsertPath={insertPath}
              />
            ))
          )}
        </div>
      </div>
      <div className="min-h-0 min-w-0">
        {selectedPath === null ? (
          <p className="p-3 text-sm text-muted-foreground">
            Выбери файл слева, чтобы посмотреть содержимое.
          </p>
        ) : previewError !== null ? (
          <p className="p-3 text-sm text-destructive">{previewError}</p>
        ) : preview === null ? (
          <p className="p-3 text-sm text-muted-foreground">Загрузка…</p>
        ) : (
          <FilePreview
            path={selectedPath}
            result={preview}
            rpc={rpc}
            onInsertPath={insertPath}
            onSaved={(content) => setPreview({ kind: "text", content, sizeBytes: content.length })}
          />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  // Opens next to the thread — in the thread's own right panel, as a
  // closable tab — never a separate app window.
  app.slots.threadPanelAction({
    id: "office-files-panel",
    title: "Файлы офиса",
    icon: "Folder",
    layout: "flush",
    component: OfficeFilesPanel,
  });
});
