import { createClient } from "@herdr-mobile/hc-client";
import { useEffect, useMemo } from "react";

export function Boot() {
  const client = useMemo(() => createClient({ write: () => {} }), []);

  useEffect(() => () => client.end(), [client]);

  return null;
}
