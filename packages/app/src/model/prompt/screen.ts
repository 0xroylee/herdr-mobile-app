export interface ScreenChoice {
  label: string;
  selected: boolean;
}

export interface ScreenDialog {
  menu: {
    choices: ScreenChoice[];
    selectedIndex: number;
  };
  question?: string;
  statement?: string;
  context: readonly string[];
}

type RowKind = "border" | "blank" | "choice" | "context" | "numbered" | "text";

interface ScreenRow {
  text: string;
  kind: RowKind;
  indentation: number;
  choice?: ParsedChoice;
}

interface ParsedChoice {
  index: number;
  marker: string | undefined;
  number: number;
  label: string;
  labelColumn: number;
}

/** Normalize the screen once, then read its final numbered menu and bounded question. */
export function readScreen(screen: readonly string[]): ScreenDialog | undefined {
  const rows = screen.map(normalizeRow);
  const menu = readFinalMenu(rows);
  if (menu === undefined) return undefined;

  const preceding = readQuestion(rows, menu.firstRow);
  const dialog: ScreenDialog = {
    menu: { choices: menu.choices, selectedIndex: menu.selectedIndex },
    context: preceding.context,
  };
  if (preceding.question !== undefined) dialog.question = preceding.question;
  if (preceding.statement !== undefined) dialog.statement = preceding.statement;
  return dialog;
}

export function keysForChoice(selectedIndex: number, targetIndex: number): string[] {
  const direction = targetIndex < selectedIndex ? "up" : "down";
  const movement = Array.from({ length: Math.abs(targetIndex - selectedIndex) }, () => direction);
  return [...movement, "enter"];
}

function normalizeRow(raw: string, index: number): ScreenRow {
  const text = raw
    .replace(/\r/g, "")
    .replace(/^([ \t]*)[│|][ \t]?/, "$1")
    .replace(/[ \t]*[│|][ \t]*$/, "");
  const indentation = text.match(/^[ \t]*/)?.[0].length ?? 0;
  if (/^[ \t]*[╭╰┌└┏┗┍┕╔╚├┤]/u.test(text)) {
    return { text, kind: "border", indentation };
  }
  if (text.trim().length === 0) return { text, kind: "blank", indentation };

  const choice = parseChoice(text, index);
  if (choice !== undefined) return { text, kind: "choice", indentation, choice };
  if (isNumberedChoiceRow(text)) return { text, kind: "numbered", indentation };
  if (/^(?:\$|\+|-|read\s|edit\s|write\s|command\s*:)/i.test(text.trim())) {
    return { text, kind: "context", indentation };
  }
  return { text, kind: "text", indentation };
}

function isNumberedChoiceRow(line: string): boolean {
  return /^[ \t]*(?:[❯›])?[ \t]*\d+[.)][ \t]*\S.*$/u.test(line);
}

function parseChoice(line: string, index: number): ParsedChoice | undefined {
  const match = line.match(
    /^[ \t]*(?<marker>[❯›])?[ \t]*(?<number>\d+)[.)][ \t]*(?<label>\S(?:.*\S)?)\s*$/u,
  );
  if (match?.groups === undefined || match.groups.label === undefined) return undefined;
  const number = Number(match.groups.number);
  if (!Number.isSafeInteger(number)) return undefined;
  const label = match.groups.label;
  return {
    index,
    marker: match.groups.marker,
    number,
    label,
    labelColumn: match[0].lastIndexOf(label),
  };
}

function readFinalMenu(
  rows: readonly ScreenRow[],
): { choices: ScreenChoice[]; firstRow: number; selectedIndex: number } | undefined {
  const parsed = rows.flatMap((row) => (row.choice === undefined ? [] : [row.choice]));
  const last = parsed.at(-1);
  if (last === undefined || last.number < 2 || last.number > parsed.length) return undefined;

  const rowsByIndex = new Map<number, ParsedChoice>();
  for (const choice of parsed) rowsByIndex.set(choice.index, choice);

  const group = [last];
  let current = last;
  for (let number = last.number - 1; number >= 1; number -= 1) {
    let previous: ParsedChoice | undefined;
    for (let index = current.index - 1; index >= 0; index -= 1) {
      const candidate = rowsByIndex.get(index);
      if (candidate === undefined) continue;
      if (candidate.number !== number) return undefined;
      previous = candidate;
      break;
    }
    if (previous === undefined) return undefined;

    for (let index = previous.index + 1; index < current.index; index += 1) {
      const row = rows[index];
      if (row === undefined || !isChoiceContinuation(row, previous.labelColumn)) return undefined;
    }
    group.unshift(previous);
    current = previous;
  }

  if (group.length < 2 || group.filter(({ marker }) => marker !== undefined).length !== 1)
    return undefined;

  const choices: ScreenChoice[] = [];
  for (let index = 0; index < group.length; index += 1) {
    const choice = group[index];
    if (choice === undefined) return undefined;
    const next = group[index + 1];
    const continuationEnd = next?.index ?? rows.length;
    const continuation: string[] = [];
    for (let rowIndex = choice.index + 1; rowIndex < continuationEnd; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined) return undefined;
      if (!isChoiceContinuation(row, choice.labelColumn)) {
        if (next !== undefined) return undefined;
        break;
      }
      continuation.push(row.text.trim());
    }
    choices.push({
      label: [choice.label, ...continuation].join(" "),
      selected: choice.marker !== undefined,
    });
  }

  if (choices.some(({ label }) => label.length === 0)) return undefined;
  const selectedIndex = choices.findIndex(({ selected }) => selected);
  if (selectedIndex < 0) return undefined;
  const firstRow = group[0]?.index;
  return firstRow === undefined ? undefined : { choices, firstRow, selectedIndex };
}

function isChoiceContinuation(row: ScreenRow, labelColumn: number): boolean {
  if (
    row.kind === "blank" ||
    row.kind === "border" ||
    row.kind === "choice" ||
    row.kind === "numbered"
  ) {
    return false;
  }
  return row.indentation >= labelColumn;
}

function readQuestion(
  rows: readonly ScreenRow[],
  firstMenuRow: number,
): { question?: string; statement?: string; context: readonly string[] } {
  let rowIndex = firstMenuRow - 1;
  while (rowIndex >= 0 && rows[rowIndex]?.kind === "context") rowIndex -= 1;

  const nearest = rows[rowIndex];
  if (nearest === undefined || nearest.kind !== "text") return { context: [] };

  const collected = [nearest];
  let start = rowIndex;
  for (let previousIndex = rowIndex - 1; previousIndex >= 0; previousIndex -= 1) {
    const previous = rows[previousIndex];
    if (
      previous === undefined ||
      previous.kind !== "text" ||
      previous.indentation !== nearest.indentation ||
      /[.!?]$/.test(previous.text.trim())
    ) {
      break;
    }
    collected.unshift(previous);
    start = previousIndex;
  }

  const text = (value: string) => value.replace(/\s+/g, " ").trim();
  const context = rows
    .slice(0, start)
    .filter(({ kind }) => kind !== "border" && kind !== "blank")
    .map(({ text: rowText }) => rowText);
  if (nearest.text.includes("?")) {
    return { question: text(collected.map(({ text: rowText }) => rowText).join(" ")), context };
  }
  return { statement: text(nearest.text), context };
}
