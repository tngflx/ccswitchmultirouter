import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSessionBackupDialog } from "@/components/sessions/CodexSessionBackupDialog";
import en from "@/i18n/locales/en.json";
import type { SessionMeta } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const translation = createInstance();
const first: SessionMeta = {
  providerId: "codex",
  sessionId: "alpha",
  title: "Alpha fix",
  projectDir: "D:\\work\\project",
  lastActiveAt: 20,
  sourcePath: "C:\\profile\\.codex\\sessions\\alpha.jsonl",
};
const second: SessionMeta = {
  ...first,
  sessionId: "beta",
  title: "Beta fix",
  lastActiveAt: 10,
  sourcePath: "C:\\profile\\.codex\\sessions\\beta.jsonl",
};
const archived: SessionMeta = {
  ...first,
  sessionId: "archived",
  title: "Archived fix",
  sourcePath: "C:\\profile\\.codex\\archived_sessions\\archived.jsonl",
};
const foreign: SessionMeta = {
  ...first,
  providerId: "claude",
  sessionId: "claude",
  title: "Claude fix",
};
const withoutSource: SessionMeta = {
  ...second,
  sessionId: "missing",
  title: "Missing source",
  sourcePath: undefined,
};

const file = "E:\\backups\\test.ccswitch-codex-backup";
const setup = async (
  sessions = [second, first, archived, foreign, withoutSource],
) => {
  const onRestore = vi.fn();
  const view = (rows: SessionMeta[]) => (
    <I18nextProvider i18n={translation}>
      <CodexSessionBackupDialog
        sessions={rows}
        isLoading={false}
        onRestore={onRestore}
      />
    </I18nextProvider>
  );
  const { rerender } = render(view(sessions));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Backup & Restore" }));
  const dialog = within(screen.getByRole("dialog"));
  return {
    user,
    dialog,
    onRestore,
    updateSessions: (rows: SessionMeta[]) => rerender(view(rows)),
  };
};

beforeAll(async () => {
  await translation.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(save).mockReset();
});

describe("CodexSessionBackupDialog", () => {
  it("offers only unarchived Codex sessions and backs up the checked subset", async () => {
    vi.mocked(save).mockResolvedValue(file);
    vi.mocked(invoke).mockResolvedValue({ count: 1 });
    const { user, dialog } = await setup();
    const checkboxes = dialog.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toHaveAccessibleName(/Alpha fix/);
    expect(checkboxes[1]).toHaveAccessibleName(/Beta fix/);
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
    expect(dialog.getByText("D:\\work\\project")).toBeVisible();

    const backup = dialog.getByRole("button", { name: "Save backup" });
    expect(backup).toBeDisabled();
    await user.click(checkboxes[1]);
    await user.type(dialog.getByRole("textbox"), "Alpha");
    expect(dialog.queryByRole("checkbox", { name: /Beta fix/ })).toBeNull();
    expect(dialog.getByText("1 selected")).toBeVisible();
    await user.click(backup);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("export_codex_session_backup", {
        targetPath: file,
        items: [{ sessionId: second.sessionId, sourcePath: second.sourcePath }],
      }),
    );
  });

  it("retains eligible selections when a refresh moves a checked session to archives", async () => {
    vi.mocked(save).mockResolvedValue(file);
    vi.mocked(invoke).mockResolvedValue({ count: 1 });
    const { user, dialog, updateSessions } = await setup();
    await user.click(dialog.getByRole("checkbox", { name: /Alpha fix/ }));
    await user.click(dialog.getByRole("checkbox", { name: /Beta fix/ }));

    updateSessions([second, { ...first, sourcePath: archived.sourcePath }]);
    expect(dialog.queryByRole("checkbox", { name: /Alpha fix/ })).toBeNull();
    expect(dialog.getByRole("checkbox", { name: /Beta fix/ })).toBeChecked();
    expect(dialog.getByText("1 selected")).toBeVisible();

    await user.click(dialog.getByRole("button", { name: "Save backup" }));
    expect(invoke).toHaveBeenCalledWith("export_codex_session_backup", {
      targetPath: file,
      items: [{ sessionId: second.sessionId, sourcePath: second.sourcePath }],
    });
  });

  it("does not export a stale selection after the native save dialog opens", async () => {
    let choosePath!: (path: string | null) => void;
    vi.mocked(save).mockReturnValue(
      new Promise((resolve) => {
        choosePath = resolve;
      }),
    );
    const { user, dialog, updateSessions } = await setup();
    await user.click(dialog.getByRole("checkbox", { name: /Alpha fix/ }));
    await user.click(dialog.getByRole("button", { name: "Save backup" }));

    updateSessions([second]);
    await act(async () => choosePath(file));

    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "The available sessions changed",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("inspects a chosen file and restores only after explicit confirmation", async () => {
    vi.mocked(open).mockResolvedValueOnce(null).mockResolvedValueOnce(file);
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        manifestHash: "inspected-hash",
        sessions: [
          { sessionId: "alpha", title: "Alpha fix", conflict: true },
          {
            sessionId: "beta",
            title: "Beta fix",
            projectPath: "D:\\work\\project",
            conflict: false,
          },
        ],
      })
      .mockResolvedValueOnce({ restored: 1, skipped: 1 });
    const { user, dialog, onRestore } = await setup();
    await user.click(dialog.getByRole("tab", { name: "Restore" }));
    const restore = dialog.getByRole("button", { name: "Restore sessions" });
    const choose = dialog.getByRole("button", { name: "Choose backup file" });
    expect(restore).toBeDisabled();
    await user.click(choose);
    expect(invoke).not.toHaveBeenCalled();

    await user.click(choose);
    expect(await dialog.findByText("Already exists")).toBeVisible();
    expect(dialog.getByText("Beta fix")).toBeVisible();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("inspect_codex_session_backup", {
      sourcePath: file,
    });
    expect(onRestore).not.toHaveBeenCalled();
    await user.click(restore);

    expect(invoke).toHaveBeenNthCalledWith(2, "import_codex_session_backup", {
      sourcePath: file,
      manifestHash: "inspected-hash",
    });
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(restore).toBeDisabled();
  });
});
