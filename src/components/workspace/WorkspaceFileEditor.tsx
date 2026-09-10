import { useDarkMode } from "@/hooks/useDarkMode";
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import MarkdownEditor from "@/components/MarkdownEditor";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { workspaceApi } from "@/lib/api/workspace";
import { LoadingStatus } from "@/components/common/DeferredContent";

interface WorkspaceFileEditorProps {
  filename: string;
  isOpen: boolean;
  onClose: () => void;
}

const WorkspaceFileEditor: React.FC<WorkspaceFileEditorProps> = ({
  filename,
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const isDarkMode = useDarkMode();

  useEffect(() => {
    if (!isOpen || !filename) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setContent("");
    workspaceApi
      .readFile(filename)
      .then((data) => {
        if (cancelled) return;
        setContent(data ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadFailed(true);
        console.error("Failed to read workspace file:", err);
        toast.error(t("workspace.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, filename, t]);

  const handleSave = useCallback(async () => {
    if (loading || loadFailed || saving) return;
    setSaving(true);
    try {
      await workspaceApi.writeFile(filename, content);
      toast.success(t("workspace.saveSuccess"));
    } catch (err) {
      console.error("Failed to save workspace file:", err);
      toast.error(t("workspace.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [filename, content, t, loading, loadFailed, saving]);

  return (
    <FullScreenPanel
      isOpen={isOpen}
      title={t("workspace.editing", { filename })}
      onClose={onClose}
      footer={
        <Button onClick={handleSave} disabled={saving || loading || loadFailed}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      }
    >
      {loading ? (
        <LoadingStatus />
      ) : loadFailed ? (
        <div role="alert">{t("workspace.loadFailed")}</div>
      ) : (
        <MarkdownEditor
          value={content}
          onChange={setContent}
          darkMode={isDarkMode}
          placeholder={`# ${filename}\n\n...`}
          minHeight="calc(100vh - 240px)"
        />
      )}
    </FullScreenPanel>
  );
};

export default function WorkspaceFileEditorSession(
  props: WorkspaceFileEditorProps,
) {
  return (
    <WorkspaceFileEditor key={`${props.isOpen}:${props.filename}`} {...props} />
  );
}
