# herdr mobile

A phone and web client for [herdr](https://herdr.dev) agents. A bridge runs next to herdr-core on the agent machine, and the app reaches it over Tailscale.

Status: scaffold. Nothing runs yet.

- Plan and decisions: [docs/research.md](docs/research.md)
- Rules for agents and contributors: [CLAUDE.md](CLAUDE.md)

## Requirements

- Bun 1.4 or newer
- Node 24 or newer, for the Expo tooling
- herdr-app, which installs herdr-core
- Tailscale on the agent machine and the phone, with MagicDNS and HTTPS certificates enabled

## Development

```sh
bun install
bun run typecheck
bun test
bun run lint
```

Start the Expo app from `packages/app` with `bun run start`.
