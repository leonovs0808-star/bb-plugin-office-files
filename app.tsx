// bb-plugin-office-files — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled),
// so this file must be loaded by BB, not imported directly.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Entry, ReadResult } from "./contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

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
}: {
  entry: Entry;
  depth: number;
  byPath: Map<string, { entries: Entry[]; error: string | null }>;
  load: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
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
      <button
        type="button"
        onClick={toggle}
        title={entry.path}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-accent",
          selectedPath === entry.path && "bg-accent",
        )}
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
        <Icon
          name={entry.kind === "directory" ? "Folder" : "File"}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.kind === "file" ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {sizeLabel(entry.sizeBytes)}
          </span>
        ) : null}
      </button>
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
            />
          ))
        )
      ) : null}
    </div>
  );
}

function FilePreview({ path, result }: { path: string; result: ReadResult | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">
        {path}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {result === null ? (
          <p className="p-3 text-sm text-muted-foreground">Загрузка…</p>
        ) : result.kind === "text" ? (
          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs">
            {result.content}
          </pre>
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
  const { byPath, rootPath, load } = useDirCache(rpc);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReadResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

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
      <div className="min-h-0 overflow-auto border-r border-border p-1.5">
        {rootError !== null ? (
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
            />
          ))
        )}
      </div>
      <div className="min-h-0">
        {selectedPath === null ? (
          <p className="p-3 text-sm text-muted-foreground">
            Выбери файл слева, чтобы посмотреть содержимое.
          </p>
        ) : previewError !== null ? (
          <p className="p-3 text-sm text-destructive">{previewError}</p>
        ) : (
          <FilePreview path={selectedPath} result={preview} />
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
