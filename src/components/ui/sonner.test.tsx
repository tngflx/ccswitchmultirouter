import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

afterEach(() => {
  toast.dismiss();
});

describe("global toaster interactions under modal dialogs", () => {
  it("keeps toast actions clickable while the modal locks the page", async () => {
    const onAction = vi.fn();
    render(
      <>
        <Dialog open>
          <DialogContent zIndex="top">
            <DialogTitle>Refreshing</DialogTitle>
            <DialogDescription>Please wait.</DialogDescription>
          </DialogContent>
        </Dialog>
        <Toaster />
      </>,
    );

    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));
    toast.warning("Recovery result", {
      action: { label: "View logs", onClick: onAction },
    });

    const action = await screen.findByRole("button", { name: "View logs" });
    const toaster = document.querySelector(
      "[data-sonner-toaster]",
    ) as HTMLElement;
    expect(toaster.style.pointerEvents).toBe("auto");

    await userEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
