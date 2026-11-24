import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Archive, Download, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sessionsApi, type CodexBackupPreview } from "@/lib/api/sessions";
import type { SessionMeta } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  formatSessionTitle,
  formatTimestamp,
  getSessionKey,
  groupSessionsByProviderAndDirectory,
  isArchivedCodexSession,
} from "./utils";

const BACKUP_EXTENSION = "ccswitch-codex-backup";
const sessionActivity = (session: SessionMeta) =>
  session.lastActiveAt ?? session.createdAt ?? 0;

interface CodexSessionBackupDialogProps {
  sessions: SessionMeta[];
  isLoading: boolean;
  onRestore: () => void;
}

export function CodexSessionBackupDialog(props: CodexSessionBackupDialogProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-auto min-h-12 flex-col gap-1 whitespace-normal px-1 py-1 text-center text-xs leading-tight"
        >
          <Archive className="size-3.5" />
          {t("sessionManager.backup.title")}
        </Button>
      </DialogTrigger>
      {isOpen && <CodexSessionBackupContent {...props} />}
    </Dialog>
  );
}

function CodexSessionBackupContent({
  sessions,
  isLoading,
  onRestore,
}: CodexSessionBackupDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState("backup");
  const [search, setSearch] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [preview, setPreview] = useState<{
    sourcePath: string;
    data: CodexBackupPreview;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const eligible = useMemo(
    () =>
      sessions
        .filter(
          (session): session is SessionMeta & { sourcePath: string } =>
            session.providerId === "codex" &&
            !!session.sourcePath &&
            !isArchivedCodexSession(session),
        )
        .sort((left, right) => sessionActivity(right) - sessionActivity(left)),
    [sessions],
  );
  const eligibleByKey = useMemo(
    () => new Map(eligible.map((session) => [getSessionKey(session), session])),
    [eligible],
  );
  const latestEligible = useRef(eligibleByKey);
  useLayoutEffect(() => {
    latestEligible.current = eligibleByKey;
  }, [eligibleByKey]);

  useEffect(() => {
    if (isLoading) return;
    setSelectedKeys((previous) => {
      const current = new Set(
        [...previous].filter((key) => eligibleByKey.has(key)),
      );
      return previous.size === current.size ? previous : current;
    });
  }, [eligibleByKey, isLoading]);

  const selected = [...selectedKeys].filter((key) => eligibleByKey.has(key));
  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matching = query
      ? eligible.filter(
          (session) =>
            formatSessionTitle(session).toLocaleLowerCase().includes(query) ||
            session.projectDir?.toLocaleLowerCase().includes(query),
        )
      : eligible;
    return (
      groupSessionsByProviderAndDirectory(
        matching,
        t("sessionManager.unknownDirectory"),
      )[0]?.directories ?? []
    );
  }, [eligible, search, t]);
  const restoreAvailable = preview?.data.sessions.some(
    (session) => !session.conflict,
  );
  const filters = [
    {
      name: t("sessionManager.backup.fileType"),
      extensions: [BACKUP_EXTENSION],
    },
  ];

  const toggleSession = (key: string, checked: boolean) =>
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  const perform = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        extractErrorMessage(failure) || t("sessionManager.backup.error"),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const exportBackup = () =>
    perform(async () => {
      const day = new Date().toISOString().slice(0, 10);
      const targetPath = await save({
        defaultPath: `codex-sessions-${day}.${BACKUP_EXTENSION}`,
        filters,
      });
      if (!targetPath) return;
      const items = selected.map((key) => {
        const session = latestEligible.current.get(key);
        if (!session) {
          throw new Error(t("sessionManager.backup.selectionChanged"));
        }
        return { sessionId: session.sessionId, sourcePath: session.sourcePath };
      });
      const { count } = await sessionsApi.exportCodexBackup(targetPath, items);
      toast.success(t("sessionManager.backup.saved", { count }));
    });

  const inspectBackup = () =>
    perform(async () => {
      const sourcePath = await open({ filters, multiple: false });
      if (!sourcePath) return;
      setPreview(null);
      const data = await sessionsApi.inspectCodexBackup(sourcePath);
      setPreview({ sourcePath, data });
    });

  const restoreBackup = () =>
    perform(async () => {
      if (!preview || !restoreAvailable) return;
      const result = await sessionsApi.importCodexBackup(
        preview.sourcePath,
        preview.data.manifestHash,
      );
      setPreview(null);
      toast.success(t("sessionManager.backup.restored", result));
      onRestore();
    });

  return (
    <DialogContent
      className="w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-lg"
      onEscapeKeyDown={(event) => {
        if (busyRef.current) event.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("sessionManager.backup.title")}</DialogTitle>
        <DialogDescription>
          {t("sessionManager.backup.description")}
        </DialogDescription>
      </DialogHeader>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setError("");
        }}
        className="flex min-h-0 flex-col"
      >
        <div className="px-6 pt-4">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="backup" disabled={busy} className="flex-1">
              {t("sessionManager.backup.backupTab")}
            </TabsTrigger>
            <TabsTrigger value="restore" disabled={busy} className="flex-1">
              {t("sessionManager.backup.restoreTab")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="backup"
          className="min-h-0 space-y-3 overflow-y-auto px-6 pb-4 pt-1"
        >
          <p className="text-sm text-muted-foreground">
            {t("sessionManager.backup.exportHint")}
          </p>
          {isLoading ? (
            <p role="status" className="text-sm">
              {t("common.loading")}
            </p>
          ) : eligible.length > 0 ? (
            <>
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("sessionManager.backup.search")}
                aria-label={t("sessionManager.backup.search")}
                disabled={busy}
              />
              {groups.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("sessionManager.backup.noMatches")}
                </p>
              )}
              {groups.map((group) => (
                <section key={group.key} className="rounded-md border">
                  <h3 className="break-all border-b bg-muted/40 px-3 py-2 text-xs font-medium">
                    {group.projectDir ?? group.label}
                  </h3>
                  <ul className="divide-y">
                    {group.sessions.map((session) => {
                      const key = getSessionKey(session);
                      return (
                        <li key={key}>
                          <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted/40">
                            <Checkbox
                              className="mt-0.5"
                              checked={selectedKeys.has(key)}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                toggleSession(key, checked === true)
                              }
                            />
                            <span className="min-w-0">
                              <span className="block break-words text-sm">
                                {formatSessionTitle(session)}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {formatTimestamp(sessionActivity(session))}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
              <p className="text-xs text-muted-foreground">
                {t("sessionManager.backup.privateData")}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("sessionManager.backup.noneEligible")}
            </p>
          )}
        </TabsContent>

        <TabsContent
          value="restore"
          className="min-h-0 space-y-3 overflow-y-auto px-6 pb-4 pt-1"
        >
          <p className="text-sm text-muted-foreground">
            {t("sessionManager.backup.restoreHint")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void inspectBackup()}
          >
            <Upload className="size-4" />
            {t("sessionManager.backup.chooseFile")}
          </Button>
          {preview && (
            <>
              {!restoreAvailable && (
                <p className="text-sm text-muted-foreground">
                  {t("sessionManager.backup.allExisting")}
                </p>
              )}
              <ul className="divide-y rounded-md border">
                {preview.data.sessions.map((session) => (
                  <li
                    key={session.sessionId}
                    className="flex items-start justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm">
                        {session.title || session.sessionId}
                      </p>
                      {session.projectPath && (
                        <p className="break-all text-xs text-muted-foreground">
                          {session.projectPath}
                        </p>
                      )}
                    </div>
                    {session.conflict && (
                      <Badge variant="secondary" className="shrink-0">
                        {t("sessionManager.backup.conflict")}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </TabsContent>

        {error && (
          <p
            role="alert"
            className="shrink-0 px-6 pb-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <DialogFooter className="flex-row flex-wrap items-center justify-end">
          {busy ? (
            <span
              role="status"
              className="mr-auto text-xs text-muted-foreground"
            >
              {t("sessionManager.backup.workInProgress")}
            </span>
          ) : (
            tab === "backup" && (
              <Badge variant="secondary" className="mr-auto">
                {t("sessionManager.selectedCount", { count: selected.length })}
              </Badge>
            )
          )}
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              {t("common.close")}
            </Button>
          </DialogClose>
          {tab === "backup" ? (
            <Button
              type="button"
              disabled={busy || isLoading || selected.length === 0}
              onClick={() => void exportBackup()}
            >
              <Download className="size-4" />
              {t("sessionManager.backup.save")}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy || !restoreAvailable}
              onClick={() => void restoreBackup()}
            >
              {t("sessionManager.backup.restore")}
            </Button>
          )}
        </DialogFooter>
      </Tabs>
    </DialogContent>
  );
}
