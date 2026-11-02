/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { KeyQueue } from "./key-queue.ts";
import { PromptAnswer } from "./prompt-answer.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("terminal input", () => {
  test("repeated keys while a call is pending arrive in order", async () => {
    const queue = new KeyQueue();
    const firstSend = deferred<boolean>();
    const calls: string[][] = [];
    const sender = async (keys: readonly string[]) => {
      calls.push([...keys]);
      return firstSend.promise;
    };
    const first = queue.send(["down"], sender);
    const second = queue.send(["down"], async (keys) => {
      calls.push([...keys]);
      return true;
    });
    const third = queue.send(["enter"], async (keys) => {
      calls.push([...keys]);
      return true;
    });

    await Promise.resolve();
    expect(calls).toEqual([["down"]]);
    firstSend.resolve(true);
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(calls).toEqual([["down"], ["down"], ["enter"]]);
  });

  test("a failed key send does not block the keys behind it", async () => {
    const queue = new KeyQueue();
    const calls: string[][] = [];
    const results = await Promise.all([
      queue.send(["down"], async (keys) => {
        calls.push([...keys]);
        throw new Error("send failed");
      }),
      queue.send(["enter"], async (keys) => {
        calls.push([...keys]);
        return true;
      }),
    ]);

    expect(results).toEqual([false, true]);
    expect(calls).toEqual([["down"], ["enter"]]);
  });

  test("a prompt double tap sends once", async () => {
    const queue = new KeyQueue();
    const prompt = new PromptAnswer(queue);
    const pending = deferred<boolean>();
    const started = deferred<void>();
    const calls: string[][] = [];
    const sender = async (keys: readonly string[]) => {
      calls.push([...keys]);
      started.resolve();
      return pending.promise;
    };
    const first = prompt.answer(["y"], sender);

    expect(prompt.getSnapshot()).toEqual({ answering: true });
    expect(await prompt.answer(["y"], sender)).toBe(false);
    await started.promise;
    expect(calls).toEqual([["y"]]);
    pending.resolve(true);
    expect(await first).toBe(true);
    expect(prompt.getSnapshot()).toEqual({ answering: false });
  });

  test("a key pressed during a pending answer is queued after it, not refused", async () => {
    const queue = new KeyQueue();
    const prompt = new PromptAnswer(queue);
    const answerPending = deferred<boolean>();
    const answerStarted = deferred<void>();
    const calls: string[][] = [];
    const answer = prompt.answer(["y"], async (keys) => {
      calls.push([...keys]);
      answerStarted.resolve();
      return answerPending.promise;
    });
    await answerStarted.promise;
    const key = queue.send(["enter"], async (keys) => {
      calls.push([...keys]);
      return true;
    });

    expect(calls).toEqual([["y"]]);
    answerPending.resolve(true);
    expect(await Promise.all([answer, key])).toEqual([true, true]);
    expect(calls).toEqual([["y"], ["enter"]]);
  });

  test("a failed prompt call restores the card, then a retry sends once", async () => {
    const queue = new KeyQueue();
    const prompt = new PromptAnswer(queue);
    const calls: string[][] = [];
    let attempts = 0;
    const sender = async (keys: readonly string[]) => {
      calls.push([...keys]);
      attempts += 1;
      if (attempts === 1) throw new Error("send failed");
      return true;
    };

    expect(await prompt.answer(["y"], sender)).toBe(false);
    expect(prompt.getSnapshot()).toEqual({ answering: false });
    expect(await prompt.answer(["y"], sender)).toBe(true);
    expect(calls).toEqual([["y"], ["y"]]);
  });
});
