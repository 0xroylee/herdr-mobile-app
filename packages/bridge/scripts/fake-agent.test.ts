import { describe, expect, test } from "bun:test";
import {
  type FakeAgentIo,
  type FakeAgentOptions,
  readFakeAgentOptions,
  runFakeAgent,
} from "./fake-agent.ts";

class FakeIo implements FakeAgentIo {
  readonly output: string[] = [];
  readonly delays: number[] = [];
  replies = 0;
  write(text: string): void {
    this.output.push(text);
  }
  async delay(ms: number): Promise<void> {
    this.delays.push(ms);
  }
  async waitForReply(): Promise<void> {
    this.replies += 1;
  }
}

const defaults: FakeAgentOptions = {
  mode: "done",
  delayMs: 0,
  exitCode: 0,
  holdMs: 0,
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
    expect(io.output.join("")).toContain("\u001b]7501;state=working\u001b\\");
    expect(io.output.join("")).toContain("\u001b]7501;state=done\u001b\\");
    expect(exitCode).toBe(0);
  });

  test("prints the numbered menu and waits for a reply in blocked mode", async () => {
    const io = new FakeIo();
    await runFakeAgent([], { ...defaults, mode: "blocked", msg: "All done" }, io);

    const output = io.output.join("");
    expect(output).toContain("Continue?\r\n1. Yes\r\n2. No\r\n");
    expect(output).toContain("\u001b]7501;state=blocked\u001b\\");
    expect(output).toContain("All done\r\nFinished.\r\n");
    expect(output).toContain("\u001b]7501;state=done\u001b\\");
    expect(output).not.toContain(";msg=");
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

  test("crash mode prints after working and exits without reporting done", async () => {
    const io = new FakeIo();
    const exitCode = await runFakeAgent(
      ["--"],
      { ...defaults, mode: "crash", exitCode: 7, lastLine: "Crash output." },
      io,
    );

    const output = io.output.join("");
    expect(output).toContain("\u001b]7501;state=working\u001b\\");
    expect(output).toContain("Crash output.\r\n");
    expect(output).not.toContain("\u001b]7501;state=done\u001b\\");
    expect(io.delays).toEqual([0]);
    expect(exitCode).toBe(7);
  });

  test("holds after done and defaults crash mode to a non-zero exit", async () => {
    const io = new FakeIo();
    await runFakeAgent([], { ...defaults, holdMs: 125 }, io);
    expect(io.output.join("")).toContain("\u001b]7501;state=done\u001b\\");
    expect(io.delays).toEqual([0, 125]);

    await expect(readFakeAgentOptions({ HERDR_FAKE_AGENT_MODE: "crash" })).resolves.toMatchObject({
      mode: "crash",
      exitCode: 1,
    });
    await expect(
      readFakeAgentOptions({ HERDR_FAKE_AGENT_MODE: "crash", HERDR_FAKE_AGENT_EXIT_CODE: "0" }),
    ).rejects.toThrow("crash mode exitCode must be non-zero");
  });

  test("reads the hold duration from its environment override", async () => {
    await expect(
      readFakeAgentOptions({ HERDR_FAKE_AGENT_HOLD_MS: "250", HERDR_FAKE_AGENT_EXIT_CODE: "7" }),
    ).resolves.toMatchObject({ holdMs: 250, exitCode: 7 });
  });
});
