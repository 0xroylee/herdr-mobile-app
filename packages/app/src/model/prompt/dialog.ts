/** A numbered approval choice after its terminal row has been classified. */
interface ChoiceRow {
  marker?: string;
  number: number;
  label: string;
  labelColumn: number;
}

interface RowBase {
  index: number;
  text: string;
}

interface BlankRow extends RowBase {
  kind: "blank";
}

interface BorderRow extends RowBase {
  kind: "border";
}

interface TextRow extends RowBase {
  kind: "text";
}

interface ClassifiedChoiceRow extends RowBase, ChoiceRow {
  kind: "choice";
}

type Row = BlankRow | BorderRow | TextRow | ClassifiedChoiceRow;

/**
 * The active dialog, partitioned once from the visible terminal rows.
 *
 * Invariants:
 * - `header` contains no blank, border, choice, or earlier-choice continuation row.
 * - `context` contains every normalized, non-border screen row before the question, in screen
 *   order; it is not truncated by the header display limit.
 * - `menu.choices` are numbered 1..N in screen order, with one selected non-empty label each.
 * - `question`, when present, is built only from `header` rows.
 */
export interface Dialog {
  context: readonly string[];
  header: readonly string[];
  question?: string;
  statement?: string;
  menu: Menu;
}

/** The final, consecutive numbered menu visible on the screen. */
export interface Menu {
  firstRow: number;
  endRow: number;
  choices: readonly { label: string; selected: boolean }[];
  selectedIndex: number;
}

const MAX_QUESTION_ROWS = 12;

/** Build one active dialog model from the top-to-bottom screen rows. */
export function readDialog(screen: readonly string[]): Dialog | undefined {
  const rows = screen.map((raw, index) => classifyRow(index, raw));
  const menu = readMenu(rows);
  if (menu === undefined) return undefined;

  const region = readHeader(rows, menu.firstRow);
  const { questionRows, questionStart, statement } = readQuestion(region);
  const contextEnd = questionStart ?? menu.firstRow;
  const context = rows
    .slice(0, contextEnd)
    .filter((row) => row.kind !== "border")
    .map((row) => row.text);
  const header = region.map((row) => row.text);
  const question = questionRows?.slice(-MAX_QUESTION_ROWS).join(" ").replace(/\s+/g, " ").trim();
  return {
    context,
    header,
    question,
    statement,
    menu,
  };
}

function classifyRow(index: number, raw: string): Row {
  const text = stripChoiceBoxBorder(raw);
  if (isBorderLine(text)) return { index, text, kind: "border" };
  if (text.trim().length === 0) return { index, text, kind: "blank" };

  const match = text.match(
    /^[ \t]*(?<marker>[❯›])?[ \t]*(?<number>\d+)[.)][ \t]*(?<label>\S(?:.*\S)?)\s*$/u,
  );
  if (match?.groups?.number !== undefined && match.groups.label !== undefined) {
    return {
      index,
      text,
      kind: "choice",
      marker: match.groups.marker,
      number: Number(match.groups.number),
      label: match.groups.label,
      labelColumn: match[0].lastIndexOf(match.groups.label),
    };
  }

  return { index, text, kind: "text" };
}

function readMenu(rows: readonly Row[]): Menu | undefined {
  const choiceCount = rows.filter((row) => row.kind === "choice").length;
  let lastChoice: ClassifiedChoiceRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "choice") {
      lastChoice = row;
      break;
    }
  }
  if (
    lastChoice === undefined ||
    !Number.isSafeInteger(lastChoice.number) ||
    lastChoice.number < 2 ||
    lastChoice.number > choiceCount
  ) {
    return undefined;
  }

  const group: ClassifiedChoiceRow[] = [];
  let current = lastChoice;
  for (let number = lastChoice.number; number >= 1; number -= 1) {
    if (current.number !== number) return undefined;
    group.unshift(current);
    if (number === 1) break;

    const previous = findPreviousChoice(rows, current.index);
    if (previous === undefined || previous.number !== number - 1) return undefined;
    for (let index = previous.index + 1; index < current.index; index += 1) {
      const row = rows[index];
      if (row === undefined || !isChoiceContinuation(row, previous.labelColumn)) return undefined;
    }
    current = previous;
  }

  const selectedIndex = group.findIndex(({ marker }) => marker !== undefined);
  if (
    selectedIndex < 0 ||
    group.some(({ marker }, index) => index !== selectedIndex && marker !== undefined)
  )
    return undefined;

  const finalChoice = group.at(-1);
  if (finalChoice === undefined) return undefined;
  let endRow = finalChoice.index + 1;
  while (endRow < rows.length) {
    const row = rows[endRow];
    if (row === undefined || !isChoiceContinuation(row, finalChoice.labelColumn)) break;
    endRow += 1;
  }

  const choices: { label: string; selected: boolean }[] = [];
  for (let index = 0; index < group.length; index += 1) {
    const choice = group[index];
    if (choice === undefined) return undefined;
    const next = group[index + 1];
    const choiceEnd = next?.index ?? endRow;
    const continuation: string[] = [];
    for (let rowIndex = choice.index + 1; rowIndex < choiceEnd; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined || !isChoiceContinuation(row, choice.labelColumn)) return undefined;
      continuation.push(row.text.trim());
    }
    const label = [choice.label, ...continuation].join(" ").trim();
    if (label.length === 0) return undefined;
    choices.push({ label, selected: choice.marker !== undefined });
  }

  return {
    firstRow: group[0]?.index ?? lastChoice.index,
    endRow,
    choices,
    selectedIndex,
  };
}

function findPreviousChoice(
  rows: readonly Row[],
  beforeIndex: number,
): ClassifiedChoiceRow | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "choice") return row;
  }
  return undefined;
}

function readHeader(rows: readonly Row[], menuFirstRow: number): readonly Row[] {
  const collected: Row[] = [];
  let index = menuFirstRow - 1;
  let stopRow: Row | undefined;

  while (index >= 0) {
    const row = rows[index];
    if (row === undefined) break;
    if (row.kind === "border" || row.kind === "blank" || row.kind === "choice") {
      stopRow = row;
      break;
    }
    collected.push(row);
    index -= 1;
  }

  collected.reverse();
  if (stopRow?.kind === "choice") {
    while (collected[0] !== undefined && isChoiceContinuation(collected[0], stopRow.labelColumn)) {
      collected.shift();
    }
  }

  return collected;
}

function readQuestion(header: readonly Row[]): {
  questionRows?: readonly string[];
  questionStart?: number;
  statement?: string;
} {
  const content = header
    .map((row) => ({ row, line: row.text.trim() }))
    .filter(({ line }) => line.length > 0 && !isContextLine(line));
  const statement = content.at(-1)?.line;
  let questionIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.line.includes("?")) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return { statement };

  let start = questionIndex;
  while (start > 0 && isQuestionContinuation(content[start - 1]?.line ?? "")) start -= 1;
  const questionRows = content.slice(start, questionIndex + 1).map(({ line }) => line);
  return {
    questionRows: questionRows.length > 0 ? questionRows : undefined,
    questionStart: content[start]?.row.index,
    statement,
  };
}

function stripChoiceBoxBorder(line: string): string {
  return line
    .replace(/\r/g, "")
    .replace(/^([ \t]*)[│|][ \t]?/, "$1")
    .replace(/[ \t]*[│|][ \t]*$/, "");
}

function isBorderLine(line: string): boolean {
  return /^\s*[╭╰┌└┏┗┍┕╔╚][─━┄┈═╴╶]*[╮╯┐┘┓┛┑┙╗╝]?\s*$/u.test(line);
}

function isChoiceContinuation(row: Row, labelColumn: number): boolean {
  if (row.kind !== "text" || row.text.trim().length === 0) return false;
  const indentation = row.text.match(/^[ \t]*/)?.[0].length ?? 0;
  return indentation >= labelColumn;
}

function isContextLine(line: string): boolean {
  return /^(?:\$|\+|-|read\s|edit\s|write\s|run\s|command\s*:)/i.test(line.trim());
}

function isQuestionContinuation(previous: string): boolean {
  if (previous.length === 0 || /[.!?]$/.test(previous)) return false;
  return !isContextLine(previous);
}

/** Map a highlighted menu row to a target row and submit it. */
export function keysForChoice(selectedIndex: number, targetIndex: number): string[] {
  const direction = targetIndex < selectedIndex ? "up" : "down";
  const movement = Array.from({ length: Math.abs(targetIndex - selectedIndex) }, () => direction);
  return [...movement, "enter"];
}
