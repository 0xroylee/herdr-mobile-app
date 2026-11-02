import type { ConfirmOptions } from "./Confirm.ts";

export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);

  const prompt = [options.title, options.message].filter(Boolean).join("\n\n");
  return Promise.resolve(window.confirm(prompt));
}
