import { StyleSheet } from "react-native";

export const HAIRLINE = StyleSheet.hairlineWidth * 2;

export const statusMarkClasses = {
  working: "h-[14px] w-[14px]",
  blocked: "min-h-[20px] items-center justify-center rounded-sm bg-blocked-tint px-[7px]",
  blockedCompact: "min-h-4 min-w-4 items-center justify-center rounded-xs bg-blocked-tint",
  done: "h-2 w-2 rounded-full bg-done",
  idle: "h-2 w-2 rounded-full border-[1.6px] border-idle",
} as const;

export const iconButtonClasses = {
  plain: {
    rest: "h-9 w-9 items-center justify-center rounded-btn",
    pressed: "h-9 w-9 items-center justify-center rounded-btn bg-raised",
  },
  boxed: {
    rest: "h-9 w-9 items-center justify-center rounded-btn border-border bg-surface",
    pressed: "h-9 w-9 items-center justify-center rounded-btn border-border bg-raised",
  },
} as const;

export const buttonClasses = {
  solid: {
    rest: "min-h-9 items-center justify-center rounded-btn bg-solid px-[13px]",
    pressed: "min-h-9 items-center justify-center rounded-btn bg-raised px-[13px]",
  },
  outline: {
    rest: "min-h-9 items-center justify-center rounded-btn border-border bg-surface px-[13px]",
    pressed: "min-h-9 items-center justify-center rounded-btn border-border bg-raised px-[13px]",
  },
  danger: {
    rest: "min-h-9 items-center justify-center rounded-btn bg-danger px-[13px]",
    pressed: "min-h-9 items-center justify-center rounded-btn bg-raised px-[13px]",
  },
  large: {
    rest: "min-h-[52px] items-center justify-center rounded-card bg-solid px-5",
    pressed: "min-h-[52px] items-center justify-center rounded-card bg-raised px-5",
  },
} as const;

export const statusTextTones = {
  blocked: "blocked",
  blockedCompact: "blocked",
  done: "done",
  idle: "dim",
  working: "working",
} as const;

export const buttonTextTones = {
  solid: { rest: "solid-fg", pressed: "fg" },
  outline: { rest: "fg", pressed: "fg" },
  danger: { rest: "danger-fg", pressed: "danger" },
  large: { rest: "solid-fg", pressed: "fg" },
} as const;
