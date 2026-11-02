# CLAUDE.md

A phone and web client for herdr agents. It talks to herdr-core (`hc`) through a bridge that runs on the agent machine and is reached over Tailscale.

Read [docs/research.md](docs/research.md) before non-trivial work. Its "Decisions" section is the source of truth for transport, security and scope.

## Layout

| Package              | What it is                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`  | The pinned herdr-core API in `schema/hc.openrpc.json`, and wire types shared by the bridge and the app                            |
| `packages/hc-client` | herdr-core client: JSON-RPC lines, framed mode, attach streams, events. The app runs it too, so it must not import Node built-ins |
| `packages/bridge`    | Daemon on the agent machine: `hc connect`, pairing, permissions, push, and the web build                                          |
| `packages/app`       | Expo app for iOS, Android and web                                                                                                 |

## Commands

```sh
bun install
bun run typecheck   # every workspace
bun test            # Bun's test runner
bun run lint        # Biome
bun run format      # Biome, writes fixes, Markdown included
```

## Rules

- Never point tests or experiments that write at the user's real herdr-core. Set `HC_SESSION=<name>` and scratch `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR`. Read-only inspection of the real core and window (`terminal.list`, `doc.get`, `herdr-app ls`, `herdr-app status`) needs the user's agreement and shouldn't print terminal names, paths, command lines or screen text.
- Never run `hc server stop`, `hc server restart` or `hc update`, and never kill the user's core. Every terminal on the machine runs in it.
- The bridge binds to `127.0.0.1` only. Never use `tailscale funnel`.
- Bun installs the workspace and runs the bridge, scripts and tests. Expo's CLI and Metro still run on Node 24.
- `bunfig.toml` uses the hoisted linker. Don't switch to isolated without checking the app on iOS, Android and web.
- Dependencies' install scripts run only if the package is listed in `trustedDependencies`. `bun pm untrusted` shows what was skipped.
- Import local files with the `.ts` extension, and use erasable TypeScript only: no enums, namespaces or parameter properties. The same code also runs through Metro and Node's type stripping.
- Add app dependencies with `bunx expo install` from `packages/app`, so versions match the Expo SDK.
- Write docs, comments and commit messages in English.
