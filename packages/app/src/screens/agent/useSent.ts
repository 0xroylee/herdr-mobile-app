import type { Status } from "@herdr-mobile/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isSent } from "../../model/sent.ts";
import { SentController } from "./sent-controller.ts";

export function useSent(status: Status | null | undefined) {
  const [controller] = useState(() => new SentController());
  const sent = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const statusRef = useRef(status);
  statusRef.current = status;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    controller.updateStatus(status, Date.now());
  }, [controller, status]);

  useEffect(() => {
    if (!sent) return;
    const timer = setInterval(() => {
      const timestamp = Date.now();
      controller.expire(timestamp);
      setNow(timestamp);
    }, 500);
    return () => clearInterval(timer);
  }, [controller, sent]);

  return {
    sent: isSent(sent, status, now),
    markSent() {
      const timestamp = Date.now();
      setNow(timestamp);
      controller.mark(statusRef.current, timestamp);
    },
  };
}
