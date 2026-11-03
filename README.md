# herdr mobile

A phone and web client for herdr-core agents. The app connects to a bridge on the agent's Mac through Tailscale.

## Packages

| Package              | Purpose                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `packages/protocol`  | Pinned herdr-core schema and shared wire types.                                             |
| `packages/hc-client` | JSON-RPC, framed streams, attachments and events for Bun and the app.                       |
| `packages/bridge`    | Bun service for pairing, device access, herdr-core sessions, app actions and the web build. |
| `packages/app`       | Expo app for iOS, Android and web.                                                          |

## Requirements

- Bun 1.4 or newer for workspace commands, tests and the bridge.
- Node 24 or newer for Expo's CLI and Metro.
- `herdr-app` with herdr-core on the agent Mac.
- Tailscale on the Mac and phone. Enable MagicDNS and HTTPS certificates. Keep the devices on the same tailnet.

## Build and check

Run these commands from the repository root:

```sh
bun install
bun run typecheck
bun test
bun run lint
bun run build:web
bun run bridge --help
```

`bun run build:web` writes the static web app to `packages/app/dist`.

## Serve and pair

For the first run, follow the [isolated scratch-core procedure](docs/smoke-checklist.md#prepare-an-isolated-run). It follows the bridge's child environment rules and the scratch setup in `docs/prototype.md`; this build has not verified end-to-end app isolation. The commands below are normal-use instructions for after the isolated first run passes. They omit `--session` and use the usual Herdr core.

Build the web app, then start the bridge from the repository root. Use the full paths to `hc` and `herdr-app` if they are not on the bridge's `PATH`.

```sh
bun run build:web
bun run bridge serve \
  --owner you@example.com \
  --port 8787 \
  --web packages/app/dist \
  --hc ~/.local/bin/hc \
  --herdr-app ~/.local/bin/herdr-app
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

The bridge listens on `127.0.0.1`. Tailscale Serve provides the HTTPS address and identity header. Never expose the bridge with Tailscale Funnel.

In another terminal, create a pairing link and QR code:

```sh
bun run bridge pair --name "My phone"
```

Scan the QR code in the app or enter the link and code on the Pair screen. The bridge guide covers launchd, watch-only devices and revoking a device in [docs/bridge.md](docs/bridge.md).

## First-run status

This build has not run in a simulator, on a device or in a browser. Use an isolated scratch herdr-core session for the first run. The [smoke checklist](docs/smoke-checklist.md) lists the checks and expected results.

Push notifications are not built. Settings currently save notification preferences only. U15 is waiting for push credentials.

Read [docs/architecture.md](docs/architecture.md) for the current app and bridge structure. [docs/feature-map.md](docs/feature-map.md) lists what a user can do and where each feature lives in the code. [docs/research.md](docs/research.md) records the transport, security and scope decisions. [CLAUDE.md](CLAUDE.md) contains repository rules.
