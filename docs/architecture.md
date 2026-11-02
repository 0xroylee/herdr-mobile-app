# Architecture

How the pieces fit, as planned on 2026-11-02. The decisions behind it are in [research.md](research.md#decisions), and the task order comes from the unshit plan for `hc-client`.

## System

```mermaid
flowchart LR
  subgraph phone["Phone or browser, with Tailscale on"]
    app["Expo app<br/>iOS, Android, web"]
  end

  subgraph mac["Agent machine, macOS"]
    serve["tailscale serve<br/>HTTPS, adds Tailscale-User-Login"]
    subgraph bridge["herdr-bridge: Bun, listens on 127.0.0.1"]
      auth["identity and device-token check"]
      proxy["one hc connect per phone session<br/>per-device method policy"]
      push["push on blocked, done, error"]
      web["serves the web build"]
    end
    hcc["hc connect<br/>stdin and stdout"]
    core["herdr-core<br/>herdr-core serve, session default"]
    cli["herdr-app ls and do"]
    window["herdr-app window"]
  end

  expo["Expo push service"]
  apns["APNs and FCM"]

  app -- "WSS over the tailnet" --> serve
  serve --> auth --> proxy --> hcc --> core
  serve --> web
  window -- "herdr-core connect" --> core
  proxy -. "spaces and tabs, window open only" .-> cli --> window
  proxy --> push --> expo --> apns --> app
```

## Packages and the hc-client layers

```mermaid
flowchart TB
  subgraph protocol["packages/protocol"]
    schema["schema/hc.openrpc.json<br/>hc 0.1.16, generation 1"]
    types["T3 method types<br/>bun run protocol:check"]
  end

  subgraph client["packages/hc-client: no runtime dependencies"]
    codec["T2 frame codec<br/>9-byte header, 16 MiB cap"]
    rpc["T4 plain JSON-RPC<br/>FIFO writes, id correlation"]
    hello["T5 hello and framed multiplexing"]
    attach["T6 attach streams<br/>credit, CLOSE, observe mode"]
    events["T7 event subscriptions<br/>snapshot, seq, missed"]
  end

  subgraph bridgepkg["packages/bridge: Bun"]
    proto["T8 prototype<br/>bun run prototype:hc"]
    xterm["@xterm/headless"]
  end

  subgraph apppkg["packages/app: Expo SDK 58"]
    screens["screens, later"]
  end

  schema --> types --> rpc
  codec --> hello
  rpc --> hello
  hello --> attach
  hello --> events
  client --> proto
  xterm --> proto
  client -. "later, over the bridge WebSocket" .-> screens
```

`bun run prototype:hc` runs the whole stack once against a scratch core. [prototype.md](prototype.md) covers its isolation, deadlines, interruption and cleanup.

## Dependencies

| Package           | Used by              | Version    | Why                                                                                                                     |
| ----------------- | -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| none              | `packages/hc-client` |            | Runs in Bun and in Hermes. Typed arrays, `DataView` and a small UTF-8 helper replace `node:buffer` and encoding globals |
| `@xterm/headless` | `packages/bridge`    | 6.0.0, MIT | Turns attach-stream bytes into screen text in the prototype                                                             |
| Bun built-ins     | `packages/bridge`    | Bun 1.4.4  | `Bun.spawn` for `hc connect`, `bun test`                                                                                |
| `typescript`      | workspace            | ~6.0.3     | Typecheck, same version as the Expo template                                                                            |
| `@biomejs/biome`  | workspace            | 2.6.4      | Lint and format                                                                                                         |
| `@types/bun`      | workspace            | ^1.4.4     | Types for Bun APIs and `bun:test`                                                                                       |
| Expo SDK 58       | `packages/app`       | 58         | Already in the scaffold; this milestone doesn't touch it                                                                |

Later milestones add `Bun.serve` for the bridge's WebSocket server, a native terminal renderer in the app (Paseo's `@xterm/headless` plus native grid is the reference), `expo-notifications` for push and `expo-camera` for QR pairing.
