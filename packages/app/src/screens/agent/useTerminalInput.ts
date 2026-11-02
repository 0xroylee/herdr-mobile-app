import { useCallback, useState, useSyncExternalStore } from "react";
import { type AgentActionPort, sendKeys } from "./actions.ts";
import { KeyQueue } from "./key-queue.ts";
import { PromptAnswer } from "./prompt-answer.ts";
import type { ActionResult } from "./screen-controller.ts";

type ActionRunner = <Value>(action: () => Promise<Value>) => Promise<ActionResult<Value>>;

/** Share ordered key delivery while giving prompt answers their own duplicate-tap latch. */
export function useTerminalInput(address: string, port: AgentActionPort, run: ActionRunner) {
  const [queue] = useState(() => new KeyQueue());
  const [promptAnswer] = useState(() => new PromptAnswer(queue));
  const answerSnapshot = useSyncExternalStore(
    promptAnswer.subscribe,
    promptAnswer.getSnapshot,
    promptAnswer.getSnapshot,
  );
  const sender = useCallback(
    async (keys: readonly string[]) => {
      const result = await run(() => sendKeys(port, address, keys));
      return result.ok;
    },
    [address, port, run],
  );
  const pressKey = useCallback((key: string) => queue.send([key], sender), [queue, sender]);
  const answerPrompt = useCallback(
    (keys: readonly string[]) => promptAnswer.answer(keys, sender),
    [promptAnswer, sender],
  );

  return { answering: answerSnapshot.answering, pressKey, answerPrompt };
}
