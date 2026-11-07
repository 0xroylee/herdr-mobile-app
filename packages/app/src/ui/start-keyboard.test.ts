/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { KeyboardEvent, KeyboardEventName, KeyboardMetrics } from "react-native";
import { createStartKeyboardTracker, type StartKeyboardSource } from "./start-keyboard.ts";

function keyboardEvent(height: number) {
  return {
    duration: 250,
    easing: "keyboard",
    startCoordinates: { screenX: 0, screenY: 844, width: 390, height },
    endCoordinates: { screenX: 0, screenY: 844 - height, width: 390, height },
    isEventFromThisApp: true,
  } satisfies KeyboardEvent;
}

function fakeKeyboard() {
  let cachedMetrics: KeyboardMetrics | undefined;
  const listeners = new Map<KeyboardEventName, Set<(event: KeyboardEvent) => unknown>>();
  const snapshotListeners: KeyboardEventName[][] = [];
  const subscribedEvents = () =>
    [...listeners].filter(([, callbacks]) => callbacks.size > 0).map(([name]) => name);
  const source: StartKeyboardSource = {
    addListener(name, listener) {
      const callbacks = listeners.get(name) ?? new Set();
      listeners.set(name, callbacks);
      callbacks.add(listener);
      return { remove: () => callbacks.delete(listener) };
    },
    metrics() {
      snapshotListeners.push(subscribedEvents());
      return cachedMetrics;
    },
  };
  return {
    source,
    snapshotListeners,
    subscribedEvents,
    emit(name: KeyboardEventName, event: KeyboardEvent) {
      // React Native's Keyboard cache changes only on completed show/hide events.
      if (name === "keyboardDidShow") cachedMetrics = event.endCoordinates;
      if (name === "keyboardDidHide") cachedMetrics = undefined;
      for (const callback of [...(listeners.get(name) ?? [])]) callback(event);
    },
  };
}

function observePadding(keyboard = fakeKeyboard(), bottomInset = 34) {
  const updates: Array<{ padding: number; event: KeyboardEvent | undefined }> = [];
  const tracker = createStartKeyboardTracker(keyboard.source, bottomInset, (padding, event) => {
    updates.push({ padding, event });
  });
  return { keyboard, tracker, updates };
}

test("animates will show, frame changes and hide, then reconciles settled padding", () => {
  const { keyboard, tracker, updates } = observePadding();
  const remove = tracker.subscribe();
  const show = keyboardEvent(334);
  const change = { ...keyboardEvent(346), duration: 180, easing: "easeInEaseOut" as const };
  const hide = keyboardEvent(346);

  keyboard.emit("keyboardWillShow", show);
  keyboard.emit("keyboardDidShow", show);
  keyboard.emit("keyboardWillChangeFrame", change);
  keyboard.emit("keyboardWillHide", hide);
  keyboard.emit("keyboardDidHide", hide);

  expect(updates).toEqual([
    { padding: 0, event: undefined },
    { padding: 300, event: show },
    { padding: 300, event: undefined },
    { padding: 312, event: change },
    { padding: 0, event: hide },
    { padding: 0, event: undefined },
  ]);
  expect(updates[1]?.event).toBe(show);
  expect(updates[3]?.event).toBe(change);
  expect(updates[4]?.event).toBe(hide);
  remove();
});

test("clears padding when mounted between willHide and didHide", () => {
  const keyboard = fakeKeyboard();
  const event = keyboardEvent(334);
  keyboard.emit("keyboardDidShow", event);
  keyboard.emit("keyboardWillHide", event);
  const { tracker, updates } = observePadding(keyboard);
  const remove = tracker.subscribe();

  expect(updates.at(-1)?.padding).toBe(300);
  keyboard.emit("keyboardDidHide", event);
  expect(updates.at(-1)).toEqual({ padding: 0, event: undefined });
  remove();
});

test("reads the settled state when hiding completes between render and subscription", () => {
  const keyboard = fakeKeyboard();
  const event = keyboardEvent(334);
  keyboard.emit("keyboardDidShow", event);
  const { tracker, updates } = observePadding(keyboard);

  expect(keyboard.snapshotListeners).toEqual([]);
  expect(updates).toEqual([]);
  keyboard.emit("keyboardWillHide", event);
  keyboard.emit("keyboardDidHide", event);
  const remove = tracker.subscribe();

  expect(updates).toEqual([{ padding: 0, event: undefined }]);
  remove();
});

test.each(["keyboardWillShow", "keyboardWillChangeFrame"] as const)(
  "sets padding when mounted after %s but before didShow",
  (missedEvent) => {
    const keyboard = fakeKeyboard();
    const event = keyboardEvent(334);
    keyboard.emit(missedEvent, event);
    const { tracker, updates } = observePadding(keyboard);
    const remove = tracker.subscribe();

    expect(updates.at(-1)?.padding).toBe(0);
    keyboard.emit("keyboardDidShow", event);
    expect(updates.at(-1)).toEqual({ padding: 300, event: undefined });
    keyboard.emit("keyboardWillChangeFrame", keyboardEvent(346));
    expect(updates.at(-1)?.padding).toBe(312);
    remove();
  },
);

test("attaches all listeners before taking the initial keyboard snapshot", () => {
  const { keyboard, tracker } = observePadding();
  const remove = tracker.subscribe();

  expect(keyboard.snapshotListeners).toHaveLength(1);
  expect(keyboard.snapshotListeners[0]?.toSorted()).toEqual([
    "keyboardDidHide",
    "keyboardDidShow",
    "keyboardWillChangeFrame",
    "keyboardWillHide",
    "keyboardWillShow",
  ]);
  remove();
});

test("uses the settled visible height when showing completes before subscription", () => {
  const { keyboard, tracker, updates } = observePadding();
  keyboard.emit("keyboardDidShow", keyboardEvent(334));
  const remove = tracker.subscribe();

  expect(updates).toEqual([{ padding: 300, event: undefined }]);
  remove();
});

test.each(["before", "after"] as const)(
  "clears padding when a dismissal frame arrives %s willHide",
  (frameOrder) => {
    const { keyboard, tracker, updates } = observePadding();
    const event = keyboardEvent(334);
    keyboard.emit("keyboardDidShow", event);
    const remove = tracker.subscribe();

    if (frameOrder === "before") keyboard.emit("keyboardWillChangeFrame", event);
    keyboard.emit("keyboardWillHide", event);
    if (frameOrder === "after") keyboard.emit("keyboardWillChangeFrame", event);
    expect(updates.at(-1)).toEqual({ padding: 0, event });
    keyboard.emit("keyboardDidHide", event);
    keyboard.emit("keyboardWillChangeFrame", event);
    expect(updates.at(-1)).toEqual({ padding: 0, event: undefined });
    remove();
  },
);

test("keeps a zero-height visible keyboard eligible for frame updates", () => {
  const { keyboard, tracker, updates } = observePadding();
  keyboard.emit("keyboardDidShow", keyboardEvent(0));
  const remove = tracker.subscribe();
  expect(updates.at(-1)?.padding).toBe(0);

  keyboard.emit("keyboardWillChangeFrame", keyboardEvent(20));
  expect(updates.at(-1)?.padding).toBe(0);
  keyboard.emit("keyboardWillChangeFrame", keyboardEvent(45));
  expect(updates.at(-1)?.padding).toBe(11);
  remove();
});

test("updates the bottom inset without rereading a stale keyboard height", () => {
  const { keyboard, tracker, updates } = observePadding();
  keyboard.emit("keyboardDidShow", keyboardEvent(334));
  const remove = tracker.subscribe();
  keyboard.emit("keyboardWillChangeFrame", keyboardEvent(346));

  tracker.setBottomInset(21);
  expect(updates.at(-1)).toEqual({ padding: 325, event: undefined });
  tracker.setBottomInset(0);
  expect(updates.at(-1)?.padding).toBe(346);
  expect(keyboard.snapshotListeners).toHaveLength(1);
  keyboard.emit("keyboardWillHide", keyboardEvent(346));
  tracker.setBottomInset(34);
  expect(updates.at(-1)?.padding).toBe(0);
  remove();
});

test("removes every listener and stops reporting after cleanup", () => {
  const { keyboard, tracker, updates } = observePadding();
  const remove = tracker.subscribe();
  const events = keyboard.subscribedEvents();
  expect(events).toHaveLength(5);

  remove();
  expect(keyboard.subscribedEvents()).toEqual([]);
  for (const name of events) keyboard.emit(name, keyboardEvent(334));
  expect(updates).toEqual([{ padding: 0, event: undefined }]);
});

test("resubscribes with the current keyboard state after cleanup", () => {
  const { keyboard, tracker, updates } = observePadding();
  const event = keyboardEvent(334);
  keyboard.emit("keyboardDidShow", event);
  tracker.subscribe()();
  keyboard.emit("keyboardDidHide", event);
  const remove = tracker.subscribe();
  expect(updates.at(-1)).toEqual({ padding: 0, event: undefined });

  const count = updates.length;
  keyboard.emit("keyboardWillShow", event);
  expect(updates).toHaveLength(count + 1);
  expect(updates.at(-1)).toEqual({ padding: 300, event });
  remove();
});
