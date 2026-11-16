import type { SpaceTabRow } from "../../model/spaces.ts";
import type { ConnectionState } from "../../store/core.ts";
import {
  type ConnectionPresentation,
  connectionPresentation,
} from "../home/connectionPresentation.ts";

export interface TerminalsPresentation {
  connection: ConnectionPresentation;
  contentOpacity: 1 | 0.6;
  pills: readonly SpaceTabRow[];
}

/** Keep retained terminal pills visible while showing the active connection state. */
export function terminalsPresentation(
  connection: ConnectionState | undefined,
  machineName: string | undefined,
  pills: readonly SpaceTabRow[],
  secureRouteAvailable: boolean,
): TerminalsPresentation {
  const connectionView = connectionPresentation(connection, machineName, secureRouteAvailable);
  return {
    connection: connectionView,
    contentOpacity: connectionView.dimmed ? 0.6 : 1,
    pills,
  };
}
