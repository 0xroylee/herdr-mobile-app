import type { Keyboard, KeyboardEvent } from "react-native";
import { startFrameKeyboardPadding } from "./modal-frame.ts";

export type StartKeyboardSource = Pick<typeof Keyboard, "addListener" | "metrics">;

/** Tracks iOS Start padding; only will events carry an animation to the caller. */
export function createStartKeyboardTracker(
  keyboard: StartKeyboardSource,
  reservedBottomInset: number,
  onChange: (padding: number, animationEvent?: KeyboardEvent) => void,
) {
  let keyboardHeight = 0;
  const updateHeight = (height: number, animationEvent?: KeyboardEvent) => {
    keyboardHeight = height;
    onChange(startFrameKeyboardPadding("ios", height, reservedBottomInset), animationEvent);
  };

  return {
    subscribe() {
      let keyboardVisible = false;
      const subscriptions = [
        keyboard.addListener("keyboardWillShow", (event) => {
          keyboardVisible = true;
          updateHeight(event.endCoordinates.height, event);
        }),
        keyboard.addListener("keyboardWillChangeFrame", (event) => {
          // A dismissal can also send a frame event with the keyboard's nonzero height.
          if (keyboardVisible) updateHeight(event.endCoordinates.height, event);
        }),
        keyboard.addListener("keyboardWillHide", (event) => {
          keyboardVisible = false;
          updateHeight(0, event);
        }),
        keyboard.addListener("keyboardDidShow", (event) => {
          keyboardVisible = true;
          updateHeight(event.endCoordinates.height);
        }),
        keyboard.addListener("keyboardDidHide", () => {
          keyboardVisible = false;
          updateHeight(0);
        }),
      ];

      // The cache records completed transitions. Read it after subscribing, never during render.
      const metrics = keyboard.metrics();
      keyboardVisible = metrics != null;
      updateHeight(metrics?.height ?? 0);

      return () => {
        for (const subscription of subscriptions) subscription.remove();
      };
    },
    setBottomInset(inset: number) {
      if (inset === reservedBottomInset) return;
      reservedBottomInset = inset;
      updateHeight(keyboardHeight);
    },
  };
}
