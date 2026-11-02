import { Text as NativeText, type TextProps as NativeTextProps } from "react-native";

export const textTones = {
  fg: "text-fg",
  muted: "text-muted",
  dim: "text-dim",
  "solid-fg": "text-solid-fg",
  "term-fg": "text-term-fg",
  working: "text-working",
  blocked: "text-blocked",
  done: "text-done",
  danger: "text-danger",
  "danger-fg": "text-danger-fg",
} as const;

export type TextTone = keyof typeof textTones;

export const textVariants = {
  largeTitle: "font-sans-semibold text-[30px] leading-[36px] tracking-[-0.025em]",
  title: "font-sans-semibold text-[16.5px] leading-[22px]",
  pairTitle: "font-sans-semibold text-[28px] leading-[34px] tracking-[-0.025em]",
  headline: "font-sans-medium text-[15.5px] leading-[20px]",
  body: "font-sans text-[15px] leading-[21px]",
  callout: "font-sans text-[13.5px] leading-[19px]",
  button: "font-sans-medium text-[13.5px] leading-[18px]",
  section: "font-sans-medium text-[13px] leading-[16px]",
  subhead: "font-sans text-[12.5px] leading-[16px]",
  caption: "font-sans text-[12px] leading-[16px]",
  micro: "font-sans-semibold text-[11.5px] leading-[14px]",
  tag: "font-sans text-[11px] leading-[14px]",
  tabLabel: "font-sans-medium text-[10.5px] leading-[13px]",
  terminal: "font-mono text-[10.6px] leading-[16.4px]",
  mono: "font-mono text-[11.5px] leading-[16px]",
  markCompact: "font-sans-semibold text-[11px] leading-[16px]",
  sectionCount: "font-sans text-[13px] leading-[16px]",
  buttonLarge: "font-sans-semibold text-[16px] leading-[20px]",
} as const;

export type TextVariant = keyof typeof textVariants;

const defaultTextTones: Record<TextVariant, TextTone> = {
  largeTitle: "fg",
  title: "fg",
  pairTitle: "fg",
  headline: "fg",
  body: "fg",
  callout: "muted",
  button: "fg",
  section: "dim",
  subhead: "dim",
  caption: "dim",
  micro: "fg",
  tag: "dim",
  tabLabel: "fg",
  terminal: "term-fg",
  mono: "dim",
  markCompact: "blocked",
  sectionCount: "dim",
  buttonLarge: "solid-fg",
};

export type TextProps = Omit<NativeTextProps, "className"> & {
  variant: TextVariant;
  tone?: TextTone;
};

export function Text({ variant, tone, allowFontScaling, ...props }: TextProps) {
  const className = [textVariants[variant], textTones[tone ?? defaultTextTones[variant]]].join(" ");
  const fontScaling = variant === "terminal" ? (allowFontScaling ?? false) : allowFontScaling;

  return <NativeText {...props} allowFontScaling={fontScaling} className={className} />;
}
