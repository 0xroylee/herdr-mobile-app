import { Icon } from "../icon.tsx";
import { Image } from "../image.ts";

export type ProgramIconSize = "row" | "pane" | "tab";

export interface ProgramIconProps {
  program: string;
  size?: ProgramIconSize;
}

const claudeIcon = require("../../../assets/icons/claude.svg");
const codexIcon = require("../../../assets/icons/codex.svg");

const programSources = new Map<string, number>([
  ["claude", claudeIcon],
  ["claude-code", claudeIcon],
  ["claude code", claudeIcon],
  ["codex", codexIcon],
]);

const sizeClasses: Record<ProgramIconSize, string> = {
  row: "h-[18px] w-[18px]",
  pane: "h-[14px] w-[14px]",
  tab: "h-[13px] w-[13px]",
};

const sizeValues: Record<ProgramIconSize, number> = {
  row: 18,
  pane: 14,
  tab: 13,
};

export function ProgramIcon({ program, size = "row" }: ProgramIconProps) {
  const source = programSources.get(program.toLowerCase());

  if (!source) return <Icon color="muted" name="bot" size={sizeValues[size]} />;

  return (
    <Image
      accessibilityLabel={`${program} icon`}
      className={sizeClasses[size]}
      contentFit="contain"
      source={source}
    />
  );
}
