import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SkillStorageLocationSettings } from "@/components/settings/SkillStorageLocationSettings";
import { skillsApi } from "@/lib/api/skills";

vi.mock("@/lib/api/skills", () => ({ skillsApi: { migrateStorage: vi.fn() } }));

it.each(["cc_switch", "unified"] as const)(
  "shows pending feedback while migrating from %s",
  async (value) => {
    let resolve!: (value: {
      migratedCount: number;
      skippedCount: number;
      errors: string[];
    }) => void;
    vi.mocked(skillsApi.migrateStorage).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onMigrated = vi.fn();
    render(
      <SkillStorageLocationSettings
        value={value}
        installedCount={0}
        onMigrated={onMigrated}
      />,
    );
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[value === "cc_switch" ? 1 : 0]);
    expect(screen.getByRole("status")).toBeInTheDocument();
    buttons.forEach((button) => expect(button).toBeDisabled());
    await act(async () =>
      resolve({ migratedCount: 0, skippedCount: 0, errors: [] }),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onMigrated).toHaveBeenCalledWith(
      value === "cc_switch" ? "unified" : "cc_switch",
    );
  },
);
