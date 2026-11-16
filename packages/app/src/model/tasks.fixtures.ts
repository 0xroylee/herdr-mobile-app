import type { Layout, TaskRecord, Terminal } from "@herdr-mobile/protocol";

export function taskRecord(suffix: string, values: Partial<TaskRecord> = {}): TaskRecord {
  const id = `tk${suffix.padStart(32, "0")}`;
  return {
    origin: "phone",
    text: "Review the task\n\nKeep the API stable.",
    run: { kind: "program", id: "claude" },
    folder: "/repo",
    createdAt: 10_000,
    ...values,
    id: values.id ?? id,
  };
}

export function taskTerminal(address: string, values: Partial<Terminal> = {}): Terminal {
  return {
    address,
    argv: ["claude"],
    cols: 80,
    created_ms: 1_000,
    cwd: "/repo",
    labels: {},
    reported: true,
    rows: 24,
    screen: "exact",
    state: "live",
    status: { state: "working" },
    status_ms: 2_000,
    turn: 1,
    ...values,
  };
}

export const taskLayout: Layout = {
  spaces: [
    {
      id: "project-work",
      name: "Work",
      folder: "/repo/work",
      tabs: [{ id: "tab-work", name: "Work tab", terminalAddresses: ["t-layout"] }],
    },
    {
      id: "project-record",
      name: "",
      folder: "/repo/record-folder",
      tabs: [],
    },
  ],
};
