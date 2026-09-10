import { expect, it } from "vitest";
import { formatRelativeTime } from "@/utils/usageRelativeTime";

it.each([
  [-1, "usage.justNow", undefined],
  [59, "usage.justNow", undefined],
  [60, "usage.minutesAgo", 1],
  [3599, "usage.minutesAgo", 59],
  [3600, "usage.hoursAgo", 1],
  [86399, "usage.hoursAgo", 23],
  [86400, "usage.daysAgo", 1],
] as const)(
  "preserves the translation boundary at %s seconds",
  (seconds, key, count) => {
    const translate = (id: string, options?: { count?: number }) =>
      `${id}:${options?.count}`;
    expect(formatRelativeTime(0, seconds * 1000, translate)).toBe(
      `${key}:${count}`,
    );
  },
);
