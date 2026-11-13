import type { Machine } from "../store/machines.ts";
import type { BridgeFetch } from "./bridge-api.ts";
import { createChannelFetch } from "./channel-fetch.ts";
import { secureSocket } from "./secure-socket.ts";
import type { Socket } from "./socket.ts";
import { webSocketFactory } from "./socket.ts";

export type MachineRoute =
  | { kind: "direct"; url: string }
  | { kind: "secure"; url: string; key: string };

export interface RouteConnection {
  socket: Socket;
  fetch: BridgeFetch;
}

export type RouteOpener = (route: MachineRoute) => RouteConnection;

export const defaultRouteOpener: RouteOpener = (route) => {
  if (route.kind === "direct") {
    return {
      socket: webSocketFactory(webSocketUrl(route.url)),
      fetch: (input, init) => globalThis.fetch(input, init),
    };
  }

  const socket = secureSocket(route);
  return {
    socket,
    fetch: createChannelFetch(socket.session, new URL(route.url).hostname),
  };
};

export function routesOf(machine: Machine): MachineRoute[] {
  const routes: MachineRoute[] = [];
  if (machine.routes.direct) routes.push({ kind: "direct", url: machine.routes.direct });
  if (machine.routes.secure) {
    routes.push({
      kind: "secure",
      url: machine.routes.secure.url,
      key: machine.routes.secure.key,
    });
  }
  return routes;
}

function webSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}
