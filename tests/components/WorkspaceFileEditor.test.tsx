import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import WorkspaceFileEditor from "@/components/workspace/WorkspaceFileEditor";
import { workspaceApi } from "@/lib/api/workspace";

vi.mock("@/lib/api/workspace", () => ({
  workspaceApi: { readFile: vi.fn(), writeFile: vi.fn() },
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({ children, footer }: any) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      aria-label="content"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

beforeEach(() => vi.clearAllMocks());

it("ignores an old file read after switching and saves only the new content", async () => {
  let resolveFirst!: (value: string) => void;
  vi.mocked(workspaceApi.readFile)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValueOnce("second contents");
  const props = { isOpen: true, onClose: vi.fn() };
  const view = render(<WorkspaceFileEditor {...props} filename="first.md" />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  view.rerender(<WorkspaceFileEditor {...props} filename="second.md" />);
  expect(await screen.findByRole("textbox")).toHaveValue("second contents");
  await act(async () => resolveFirst("stale contents"));
  expect(screen.getByRole("textbox")).toHaveValue("second contents");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "common.save" })),
  );
  expect(workspaceApi.writeFile).toHaveBeenCalledWith(
    "second.md",
    "second contents",
  );
});

it("blocks saving after a failed read instead of writing blank or stale data", async () => {
  vi.mocked(workspaceApi.readFile).mockRejectedValueOnce(
    new Error("read denied"),
  );
  render(<WorkspaceFileEditor isOpen filename="denied.md" onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "workspace.loadFailed",
  );
  expect(screen.getByRole("button", { name: "common.save" })).toBeDisabled();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(workspaceApi.writeFile).not.toHaveBeenCalled();
});
