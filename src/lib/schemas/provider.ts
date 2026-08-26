import { z } from "zod";
import i18n from "@/i18n";

/**
 * 解析 JSON 语法错误，提取位置信息
 */
function parseJsonError(error: unknown): string {
  if (!(error instanceof SyntaxError)) {
    return i18n.t("validation.invalidConfigJson");
  }

  const message = error.message;

  // 提取位置信息：Chrome/V8: "Unexpected token ... in JSON at position 123"
  const positionMatch = message.match(/at position (\d+)/i);
  if (positionMatch) {
    const position = parseInt(positionMatch[1], 10);
    return i18n.t("validation.jsonErrorWithPosition", {
      message: message.split(" in JSON")[0],
      position,
    });
  }

  // Firefox: "JSON.parse: unexpected character at line 1 column 23"
  const lineColumnMatch = message.match(/line (\d+) column (\d+)/i);
  if (lineColumnMatch) {
    const line = lineColumnMatch[1];
    const column = lineColumnMatch[2];
    return i18n.t("validation.jsonErrorLineColumn", { line, column });
  }

  // 通用情况：提取关键错误信息
  const cleanMessage = message
    .replace(/^JSON\.parse:\s*/i, "")
    .replace(/^Unexpected\s+/i, i18n.t("validation.wordUnexpected"))
    .replace(/token/gi, i18n.t("validation.wordToken"))
    .replace(/Expected/gi, i18n.t("validation.wordExpected"));

  return i18n.t("validation.jsonErrorGeneric", { message: cleanMessage });
}

export const providerSchema = z.object({
  name: z.string(), // 必填校验移至 handleSubmit 中用 toast 提示
  websiteUrl: z
    .string()
    .url(i18n.t("validation.invalidUrl"))
    .optional()
    .or(z.literal("")),
  notes: z.string().optional(),
  settingsConfig: z
    .string()
    .min(1, i18n.t("validation.configRequired"))
    .superRefine((value, ctx) => {
      try {
        JSON.parse(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: parseJsonError(error),
        });
      }
    }),
  // 图标配置
  icon: z.string().optional(),
  iconColor: z.string().optional(),
});

export type ProviderFormData = z.infer<typeof providerSchema>;
