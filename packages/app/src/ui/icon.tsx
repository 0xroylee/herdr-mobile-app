import {
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Ellipsis,
  Eye,
  GitBranch,
  Layers,
  Plus,
  ScanLine,
  Search,
  Settings,
} from "lucide-react-native";
import { useCSSVariable } from "uniwind";

const icons = {
  "arrow-up": ArrowUp,
  bot: Bot,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  clock: Clock,
  copy: Copy,
  ellipsis: Ellipsis,
  eye: Eye,
  "git-branch": GitBranch,
  layers: Layers,
  plus: Plus,
  "scan-line": ScanLine,
  search: Search,
  settings: Settings,
} as const;

const sizePresets = {
  segment: 15,
  chip: 15,
  row: 17,
  title: 20,
  tab: 23,
  back: 24,
} as const;

const colorVariables = {
  fg: "--color-fg",
  muted: "--color-muted",
  dim: "--color-dim",
  "solid-fg": "--color-solid-fg",
  working: "--color-working",
  blocked: "--color-blocked",
  done: "--color-done",
  idle: "--color-idle",
  danger: "--color-danger",
  "danger-fg": "--color-danger-fg",
  focus: "--color-focus",
} as const;

export type IconName = keyof typeof icons;
export type IconSize = keyof typeof sizePresets;
export type IconColor = keyof typeof colorVariables;

export interface IconProps {
  name: IconName;
  size?: IconSize | number;
  color?: IconColor;
  strokeWidth?: number;
}

export function Icon({ name, size = "row", color = "dim", strokeWidth = 1.8 }: IconProps) {
  const IconComponent = icons[name];
  const tokenColor = useCSSVariable(colorVariables[color]);

  return (
    <IconComponent
      color={typeof tokenColor === "string" ? tokenColor : undefined}
      size={typeof size === "number" ? size : sizePresets[size]}
      strokeWidth={strokeWidth}
    />
  );
}
