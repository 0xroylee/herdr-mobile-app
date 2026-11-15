import { describe, expect, test } from "bun:test";
import {
  type FakeAgentIo,
  type FakeAgentOptions,
  readFakeAgentOptions,
  runFakeAgent,
} from "./fake-agent.ts";

class FakeIo implements FakeAgentIo {
  readonly output: string[] = [];
  replies = 0;
  write(text: string): void {
    this.output.push(text);
  }
  async delay(): Promise<void> {}
  async waitForReply(): Promise<void> {
    this.replies += 1;
  }
}

const defaults: FakeAgentOptions = {
  mode: "done",
  delayMs: 0,
  exitCode: 0,
  lastLine: "Finished.",
  question: "Continue?",
  choices: ["Yes", "No"],
};

describe("fake-agent", () => {
  test("prints the prompt as one argv element", async () => {
    const io = new FakeIo();
    const task = "Review this change and keep spaces intact";
    const exitCode = await runFakeAgent(["--", task], defaults, io);

    expect(io.output[0]).toBe(`${JSON.stringify(["--", task])}\r\n`);
    expect(io.output.join("")).toContain("state=working");
    expect(io.output.join("")).toContain("state=done");
    expect(exitCode).toBe(0);
  });

  test("prints the numbered menu and waits for a reply in blocked mode", async () => {
    const io = new FakeIo();
    await runFakeAgent([], { ...defaults, mode: "blocked", msg: "All done" }, io);

    expect(io.output.join("")).toContain("1. Yes\r\n2. No\r\n");
    expect(io.output.join("")).toContain("state=blocked;msg=Continue?");
    expect(io.output.join("")).toContain("state=done;msg=All done");
    expect(io.replies).toBe(1);
  });

  test("reads environment overrides for status mode and exit code", async () => {
    await expect(
      readFakeAgentOptions({
        HERDR_FAKE_AGENT_MODE: "blocked",
        HERDR_FAKE_AGENT_DELAY_MS: "25",
        HERDR_FAKE_AGENT_EXIT_CODE: "7",
        HERDR_FAKE_AGENT_CHOICES: "Allow|Deny",
      }),
    ).resolves.toMatchObject({
      mode: "blocked",
      delayMs: 25,
      exitCode: 7,
      choices: ["Allow", "Deny"],
    });
  });
});
