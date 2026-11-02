# herdr mobile app research

Researched 2026-10-30. The goal is a phone and web client for herdr that matches what Paseo gives you today: remote access through an end-to-end encrypted relay, a mobile app, and push notifications when an agent needs you.

## Summary

Build on herdr-core, not the herdr 0.9 socket API. herdr's new desktop app runs on herdr-core, which doesn't share sessions with the old 0.9 TUI. A client built on the old API can't see agents started in the app. By 2026-11-01, Ovis, Collie, Pairfob and Shepherdr all read herdr-core, and Ovis already ships phone apps and push over Tailscale; see [Existing herdr phone clients](#existing-herdr-phone-clients). This project targets herdr-core with a native app. v1 uses Tailscale as well; Paseo's relay design is the upgrade path if that stops being enough.

## Decisions

- **2026-10-31: Tailscale for the v1 transport.** The phone reaches the bridge over the user's tailnet through `tailscale serve`. There is no relay in v1. The bridge keeps its transport behind one interface, so the Durable Object relay in [Relay on Cloudflare](#relay-on-cloudflare) can be added later without changing the protocol. What follows from it:
  - No Noise layer. WireGuard already encrypts traffic device to device, and Tailscale's DERP relays only see WireGuard packets.
  - The bridge listens on `127.0.0.1` only. `tailscale serve` gives it HTTPS at `<machine>.<tailnet>.ts.net` and adds a `Tailscale-User-Login` header. It strips that header from incoming requests, so tailnet clients can't forge it. The bridge checks it against the owner's login, can confirm the peer with `tailscale whois`, and then checks a per-device token from pairing. Local processes can forge the header, but they can reach herdr-core directly anyway.
  - Tagged devices and Funnel traffic get no identity header. Never run `tailscale funnel` on the bridge; it would put the bridge on the public internet.
  - Pairing is a QR code carrying the bridge URL and a one-time code, not a public key.
  - The bridge serves the web build on the same HTTPS hostname.
  - Push still goes through Expo, so it reaches the phone with Tailscale off. Opening the details needs Tailscale on.
  - On iOS, Tailscale takes the only VPN slot, so it can't run beside a proxy app.
  - Enabling HTTPS certificates publishes the machine names and the tailnet's DNS name in the public Certificate Transparency logs.
- **2026-11-01: Bun workspaces with the hoisted linker.** Bun installs the monorepo and runs the bridge, scripts and tests, and `bun build --compile` can ship the bridge as one binary. Expo's CLI and Metro still run on Node. `bunfig.toml` sets `linker = "hoisted"`, the setting [Tamagui](https://github.com/tamagui/tamagui) uses to run Expo SDK 58 on Bun 1.4. The first `bun install` took 47 s; the same tree took about 15 minutes with npm on this network. If Bun breaks the Expo install, fall back to pnpm with `nodeLinker: hoisted`.

## What herdr looks like now

herdr is three separate products. On 2026-10-30 this machine had only the old TUI installed, version 0.9.0. The latest release was 0.9.5.

| Product                             | What it is                                                   | API                                                                            |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `herdr` 0.9.x                       | The original TUI                                             | `~/.config/herdr/herdr.sock`, 102 methods, no live output stream               |
| `herdr-core` / `hc` 0.1.14, preview | Background service that owns the terminals and draws nothing | JSON-RPC over a Unix socket, 32 methods, OpenRPC schema, live terminal streams |
| `herdr-app`                         | The new desktop app, repo created 2026-10-16                 | A herdr-core client that stores spaces and tabs inside core                    |

herdr-core already has what a phone needs:

- **Watch mode.** `terminal.attach` with `observe: true` streams a live terminal without typing into it or resizing it. The last active viewer sets the terminal size, so without this the phone would shrink your desktop terminal.
- **Slow-network handling.** A viewer that falls more than 4 MiB behind gets a fresh screen instead of the backlog.
- **Sending input.** `terminal.send` pastes text and presses Enter once nobody has typed for about 3 seconds. It refuses an agent waiting on a permission prompt unless you force it. `terminal.keys` covers Esc, Ctrl-C and arrows.
- **Events.** `events.subscribe` gives a snapshot, then numbered events and a heartbeat every 15 s. A subscriber that falls behind gets a fresh snapshot.
- **Agent status.** Agents report their own state through OSC 7501, Mitchell Hashimoto's Program Status Protocol: idle, working, blocked, done or error. Blocked records can include the question text. Third-party pull requests say Claude Code 2.1.295+ and Codex 0.163+ emit it themselves. Push notifications hang off this.
- **Stdio transport.** `hc connect` carries the protocol over stdin/stdout, so the bridge never needs socket paths.
- **Remote machines.** Machines added with `hc machine add` appear in the same event stream, addressed like `box/t7`.

Core has no authentication. Its security doc says anyone who can connect "can run commands, read and change files, and control its terminals." Its only remote access is SSH. The bridge has to provide pairing, encryption and access rules itself.

## Existing herdr phone clients

Surveyed 2026-11-01. The list grew from three projects to dozens in a few weeks; these are the ones that matter for herdr-app users. herdr plugins (`herdr plugin install`) hook into the herdr 0.9 TUI server, so a plugin only helps herdr-app users if it also speaks herdr-core.

| Project                                                                | Transport                                                                                                       | Phone                                                 | herdr-core                                             | Notes                                                                                                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ovis](https://github.com/devswha/ovis), MIT, 1.7k stars               | Tailscale, a VPN or an SSH tunnel; no hosted relay                                                              | iPhone TestFlight beta, Android Google Play beta, PWA | Yes, with `OVIS_RUNTIME=herdr-core` on macOS and Linux | Agents as chats, prompts as cards, push with the app closed. On core it can't create, rename or rearrange spaces, tabs or splits. Anonymous usage counts are on by default |
| [Collie](https://github.com/AltanS/collie), MIT, 1.5k stars            | Tailscale                                                                                                       | PWA with Web Push                                     | Experimental, with `COLLIE_MUX=herdr-core`             | Crews of several machines behind one URL                                                                                                                                   |
| [Shepherdr](https://github.com/eliasstravik/shepherdr), MIT, 1k stars  | `tailscale serve`                                                                                               | Web app                                               | Built for it                                           | Mission control: a coordinator agent per space and a worktree per task                                                                                                     |
| [Pairfob](https://github.com/arronKler/pairfob), Apache-2.0, 181 stars | E2EE relay on a Cloudflare Worker and Durable Object, upgraded to WebRTC when possible; SPAKE2+ pairing; no VPN | PWA, Android beta                                     | Yes, with `install.sh --runtime core`                  | On core: one terminal per pane, no tabs, splits, worktrees or transcript chat. The relay code is in `workers/pairfob-origin`                                               |
| [Nenu](https://github.com/frizynn/nenu), MIT                           | Tailscale                                                                                                       | PWA with Web Push                                     | Being ported                                           | Chat view built from agent transcripts                                                                                                                                     |

These support only the herdr 0.9 TUI, as far as their READMEs say: [herdr-mobile-relay](https://github.com/0cv/herdr-mobile-relay), a plugin with an encrypted transport; [herdr-remote](https://github.com/dcolinmorgan/herdr-remote), a Python relay with Telegram and a Cloudflare tunnel option; [QuickTUI](https://github.com/quicktui/quicktui-herdr), an App Store app with an E2EE cloud relay; [HerdrChat](https://github.com/cobanov/herdrchat), an App Store app built with Expo that connects over SSH; and [herdr-relay](https://github.com/hackerchai/herdr-relay), an E2EE relay in Rust with a hosted default.

Ovis already covers most of this project's goal on herdr-core: Tailscale, phone apps and push. Try it before building more. What would still justify this project is whatever Ovis lacks after real use, such as a store app, managing spaces and tabs on core once herdr-app#43 settles, or a relay. If a relay is added, Pairfob's is the reference.

Nenu's [ARCHITECTURE.md](https://github.com/frizynn/nenu/blob/main/ARCHITECTURE.md) has three lessons worth copying:

- Agent TUIs draw on the alternate screen, so the terminal keeps no scrollback. History has to come from each agent's own transcript files, which are JSONL for Claude Code and Codex, with one adapter per agent.
- Turn recognized prompts, like permission dialogs and menus, into buttons. Keep a "send exactly what I type" fallback.
- Show "Sent" and then the agent switching from blocked to working, or people tap twice.

## What to take from Paseo

Paths are relative to the local checkout at `/Users/roy/Desktop/SourceCode/openhark/paseo`. It's all Apache-2.0, so you can reuse it with attribution.

| Piece          | How Paseo does it                                                                                                                                                                                                                                   | Use for herdr                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Encryption     | Noise NK. The phone gets the daemon's public key from the pairing QR, so the relay only sees ciphertext. Code is in `packages/relay/src/secure-channel.ts`, `noise/` and `protected-records.ts`. The design is in `docs/relay-endpoint-security.md` | Not needed over Tailscale. Reuse it if a relay is added                                                                                      |
| Relay server   | The production relay is [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay), written in Elixir. The Cloudflare relay in `packages/relay` is legacy and no longer deployed                                                               | Deferred, see [Decisions](#decisions) and [Relay on Cloudflare](#relay-on-cloudflare). Don't use `relay.paseo.sh`, that's Paseo's own server |
| Pairing        | A QR or link `https://app.paseo.sh/#offer=<base64url>` holding the server id, public key and relay address. The part after `#` never reaches a server. Format is in `packages/protocol/src/connection-offer.ts`                                     | Reuse the QR flow to carry the bridge URL and a one-time pairing code                                                                        |
| Push           | The daemon calls Expo's push service. Tokens expire after 48 h unless renewed. See `packages/server/src/server/push/` and `docs/notifications.md`                                                                                                   | Same, triggered by agent status changes                                                                                                      |
| Phone terminal | `@xterm/headless` parses the output and native React Native views draw it, in `packages/app/src/terminal/native-renderer/`. The web build uses xterm.js                                                                                             | Feed it herdr-core's terminal stream                                                                                                         |
| App            | Expo 57, React Native 0.86, expo-router, zustand, react-query, expo-sqlite, expo-camera for QR, EAS for builds                                                                                                                                      | Same stack                                                                                                                                   |

One part doesn't carry over. Paseo runs agents through their SDKs, so its main screen is a structured chat. herdr agents are plain terminals. A herdr app starts with terminals and status. A chat view comes later, built from transcripts the way Nenu does it.

## Proposed architecture

```
Phone / browser: Expo app on iOS, Android, web, with Tailscale on
      │  HTTPS and WebSocket to https://<machine>.<tailnet>.ts.net
      │  WireGuard inside the tailnet, direct or through Tailscale's DERP relays
      ▼
tailscale serve on the agent machine: TLS, adds Tailscale-User-Login
      │  http://127.0.0.1:<port>
      ▼
herdr-bridge: new code, runs where the agents run
  • checks Tailscale-User-Login, then the device token from pairing
  • pairing, device list and revoke, QR with the bridge URL and a one-time code
  • per phone session: start `hc connect` and pass messages through
  • per-device permissions, e.g. a watch-only device can list, read and observe
  • watch core events → push via Expo on blocked, done, error, unless that phone is already watching
  • serves the web build
  • later: transcript readers for a chat view
      │  stdin/stdout
      ▼
herdr-core  ◄── herdr-app desktop window, same terminals and spaces
```

Recommended decisions:

1. **Pass core's protocol through instead of designing a new API.** The phone talks to herdr-core directly. The bridge adds a few calls of its own for push, devices and history. Core's API is add-only, and a test fails on any change that would break existing clients. That makes the phone another core client, like herdr-app. The bridge checks the method name of each call against the device's permissions and forwards the rest.
2. **Read spaces and tabs defensively.** herdr-app documents `herdr.space` and `herdr.tab` labels on terminals. The app's stored layout has names and order, but its format is private to the app. Nenu's author asked upstream which one clients should use in [herdr-app#43](https://github.com/herdrdev/herdr-app/issues/43), with no answer as of 2026-10-30. [Supporting herdr-app](#supporting-herdr-app) has the plan.
3. **Run the bridge on a machine that stays awake.** A sleeping MacBook means the phone shows nothing.
4. **Keep message text out of push payloads, or encrypt it.** Paseo puts message previews in the push, which Expo, Apple and Google can read. Either send a generic alert and load details over the tailnet, or encrypt the payload and decrypt it on the phone with an iOS Notification Service Extension.

## Supporting herdr-app

Researched 2026-11-01. herdr-app keeps its state in two places, so the bridge on the Mac talks to both:

| Layer                                            | Available                              | Use it for                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| herdr-core, through `hc connect`                 | Always, with the window open or closed | Terminals, status, events, attach, send and keys, starting terminals with `terminal.run`, reading the `herdr-app` document                                  |
| The open window, through `herdr-app do <action>` | Only while the window is open          | Making, renaming, moving and closing spaces and tabs, splitting panes. `space.new` and `tab.new` also take an agent (`argv`) and its first message (`task`) |

Ovis lists space and tab changes as unsupported on core, because it only talks to core. Calling `herdr-app do` from the bridge is the way around that while the window is open.

- **Structure.** Read space and tab names and their order from the core document `herdr-app` with `doc.get`, and fetch it again on its `doc` event, after a reconnect and after `missed`. Its format belongs to the app, so parse it defensively and fall back to the `herdr.space` and `herdr.tab` labels on terminals. While the window is open, `herdr-app ls` is the documented way to inspect it.
- **Changes.** With the window open, run `herdr-app do` on the Mac. Arguments are named flags or one JSON object. With it closed, start terminals with `terminal.run`, `keep` and the space and tab labels; an id the app doesn't know becomes a new unnamed space or tab. Disable the other actions. Ask on the phone before any action that ends terminals: `space.close`, `tab.close`, `pane.close` and `terminal.kill`.
- **Terminal size.** The last viewer that types or resizes sets the size, so typing through an attach from the phone also resizes that terminal in the Mac window. Watch with `observe: true`, send prompts with `terminal.send` and keys with `terminal.keys`, and make a full takeover an explicit action.
- **Attention.** herdr-app shows Working, Blocked, Done and Idle. Done means it finished while nobody was looking, and each screen tracks that on its own, so the phone keeps its own seen state.
- **Push.** herdr-app already alerts on the Mac. Skip phone pushes while the Mac is in use, judged by its input idle time and whether the screen is locked.
- **Other machines.** SSH machines added in herdr-app are core machines. Their terminals arrive in the same event stream, addressed like `box/t7`, and their layout is `doc.get` with `on: "box"`.
- **Running on the Mac.** Run the bridge as a launchd LaunchAgent with `KeepAlive`, and give it the full paths of `hc` and `herdr-app`, because launchd's `PATH` is short. Keep the Mac awake on power, or run the agents on an always-on Mac added as a machine.

### Verified on this Mac, 2026-11-01

herdr-app 0.1.10 from the DMG, herdr-core 0.1.16. The window held one space with one tab and one shell, so splits and mod panes haven't been seen yet.

- **Install.** The app installs the core on first launch as `~/.local/bin/herdr-core`, with `~/.local/bin/hc` linking to it. `~/.local/bin/herdr-app` links to `/Applications/Herdr.app/Contents/MacOS/Herdr`, so the GUI binary is also the CLI. The app runs `herdr-core serve` and talks to it through a `herdr-core connect` child process, the same way the bridge will.
- **Session.** `default`. Its socket is `~/.local/state/herdr-core/default/default.sock`, because macOS has no `XDG_RUNTIME_DIR`.
- **`hello`.** Version 0.1.16, protocol generation 1, features `framed`, `attach`, `events`, `status` and `shell`.
- **The `herdr-app` document**, at document version 1:

  ```
  spaces[]: id "sp…", name ("" when unnamed), folder, tabs[]
    tabs[]: id "tb…", name ("" when unnamed), root
      root: a layout tree. Containers have a type such as "row", an id and children;
            leaves have type "block", an id "p…" and content.terminal, e.g. "t1"
  ```

- **Labels.** A terminal's `herdr.space` and `herdr.tab` are the document's space and tab ids. A third label, `where`, is display text such as `~ / 1`. Terminals the app holds have `keep: true`.
- **`herdr-app ls`** prints JSON with no flags: `spaces[]` with `id`, `name`, `folder`, `machine` (null for this Mac), `active` and `tabs[]`. Each tab has `id`, `name`, `active`, `settled` and `terminals[]`, and each terminal has `terminal`, `pane`, `status`, `app`, `name` and `sub_agents[]`. A `recent[]` list follows.
- **`herdr-app status`** prints JSON with the selected `space`, `tab` and `focused_pane`, the `layout` name, zoom and font sizes.
- **CLI usage:** `herdr-app ls | commands | status | shot [file.png] | do <command> [--arg value ... | json]`.

## Setup

Accounts and hosting:

- Apple Developer Program, for TestFlight and push keys
- Google Play Console, or distribute APK files yourself
- An Expo account with an EAS project, plus a Firebase project for Android push
- A Tailscale account. The free Personal plan covers 6 users with unlimited devices, for non-commercial use. In the admin console's DNS page, turn on MagicDNS, then Enable HTTPS under HTTPS Certificates

Local:

- **Tailscale** on the agent machine and on the phone, signed in to the same tailnet. On 2026-10-31 this Mac didn't have it installed.
- **herdr-app**, which also installs herdr-core: `curl -fsSL https://releases.herdr.dev/app/install.sh | sh`. Read the script first, it downloads and runs code.
- **API types.** Save the API with `hc schema > hc.openrpc.json` and generate TypeScript types from it.
- **Test isolation.** Run tests against a throwaway core with `HC_SESSION=test` and separate `XDG_STATE_HOME` and `XDG_CONFIG_HOME`. herdr-core's own docs say tests must stay off your real core.
- **Tooling.** Xcode with a simulator, Android Studio, the Expo dev client, Bun 1.4 for the workspace, and Node 24 for the Expo tooling.

Folder layout:

```
herdr-mobile-app/
  packages/hc-client   TypeScript client for herdr-core: calls, terminal streams, events
  packages/protocol    types generated from hc.openrpc.json, plus the bridge's own messages
  packages/bridge      daemon: hc connect, pairing, permissions, push, serves the web build
  packages/app         Expo app for iOS, Android and web
```

## Order of work

1. **Prototype script.** Install herdr-app and run Claude Code and Codex in it. Write a small script that connects to core, logs status changes, and renders one agent's terminal in watch mode with `@xterm/headless`. Confirm Claude Code's status reports arrive. Claude Code only reports after the terminal answers a startup query, and [herdr discussion #5106](https://github.com/herdrdev/herdr/discussions/5106) shows that failing.
2. **First app over Tailscale.** Bridge on `127.0.0.1` behind `tailscale serve`, with the identity header check and a pairing token. App with an agent list sorted blocked, done, working, idle, which matches the desktop app. Add a watch-mode terminal, a text box that uses `terminal.send`, a key bar that uses `terminal.keys`, and push on blocked, done and error.
3. **Web build.** The bridge serves the Expo web build on the same hostname, so any browser on the tailnet works.
4. **Extras.** Spaces and tabs, starting agents from the phone with `terminal.run` and the space and tab labels, more machines, a chat view built from transcripts, prompts as buttons.
5. **Relay, only if Tailscale stops being enough.** See [Relay on Cloudflare](#relay-on-cloudflare).

Risks:

- herdr-core is still a 0.1.x preview, though its API only adds things.
- The app's stored layout format may change. See herdr-app#43.
- The phone can do anything a shell on your machine can, so device revoke and per-device permissions belong in the first version.

## Relay on Cloudflare

Researched 2026-10-31, then deferred the same day in favor of Tailscale; see [Decisions](#decisions). It stays here for when a relay is needed. Cloudflare can carry the relay in two ways.

### Option 1: Durable Object relay

Deploy Paseo's legacy relay, `packages/relay/src/cloudflare-adapter.ts` (614 lines), to your own Cloudflare account. It runs one Durable Object per `serverId` and uses the WebSocket Hibernation API, so idle sockets don't bill duration. It speaks the same v2 protocol as `getpaseo/paseo-relay`, so you can move to the Elixir relay later without changing the bridge or the app.

Limits and cost, from Cloudflare's [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) pages:

- The Free plan runs SQLite-backed Durable Objects with 100,000 requests and 13,000 GB-s of duration per day. Past either limit, calls fail until 00:00 UTC.
- The Workers Paid plan is $5 a month and includes 1 million requests and 400,000 GB-s per month.
- Every incoming WebSocket message counts, billed at 20 messages per request. Outgoing messages and WebSocket protocol pings are free. The pricing page calls the 20:1 ratio "billing-only", and an October 2026 [community report](https://community.cloudflare.com/t/durable-objects-free-quota-block-below-100k-after-websocket-20-1-adjustment/967650) describes the Free quota blocking well below 100,000 even after applying 20:1. Plan the Free tier as 100,000 incoming messages a day.
- A Durable Object can receive WebSocket messages up to 32 MiB, raised from 1 MiB in October 2025. herdr-core frames are at most 16 MiB.
- Deploying new relay code closes every socket. The bridge and the app have to reconnect on their own.

A rough personal estimate: watching terminals 2 hours a day, with the bridge batching output to at most 20 messages a second, is about 150,000 incoming messages a day. On the Paid plan that's under 10,000 billed requests a day. On the Free plan it's over the cap, so the [free setup](#running-the-relay-for-free) batches harder.

Paseo stopped serving traffic from this code on 2026-07-11, when `relay.paseo.sh` became a proxy to the Elixir relay on Fly. The commit gives no reason. The Elixir relay's settings for slow-consumer shedding, delivery timeouts, memory watermarks and metrics point to backpressure and visibility at scale. The DO adapter forwards with a plain `target.send(message)` and has no backpressure. herdr-core's credit flow control caps each attach stream at one credit window in flight, which bounds the terminal traffic.

Fix these before putting it on the internet:

1. **Server-role takeover.** A new `role=server` socket for a `serverId` closes the existing one, so anyone who learns your `serverId` can keep knocking your bridge off. Noise stops them from reading traffic or posing as the bridge, so the damage is denial of service. Derive `serverId` from the bridge's Ed25519 public key and make server-role connections sign a nonce from the relay. A relay only you use can check a shared secret header instead.
2. **Memory caps.** `pendingFrames` keeps at most 200 frames per connection but has no global limit and no per-frame limit. Paseo closed [#376](https://github.com/getpaseo/paseo/issues/376) as superseded, not fixed. Cap pending connections, total buffered bytes and frame size.
3. **Route keys.** The Elixir relay rejects a `serverId` or `connectionId` over 256 bytes. The DO relay doesn't check. Add the same check.
4. **Message count.** Billing counts messages, not bytes. Batch frames in the bridge, for example every 50 ms, and use protocol pings for the bridge's keepalive.
5. **Domain.** Use a custom domain, not `workers.dev`. A report from around 2022 says `workers.dev` was SNI-blocked in mainland China; I found nothing current.

### Option 2: Cloudflare Tunnel

Skip the relay. The bridge listens on localhost, and `cloudflared` publishes it at a hostname on your domain. The phone connects straight to that hostname.

Advantages:

- Tunnels are free, with no bandwidth charge.
- There is no relay code to write or run. `cloudflared` dials out, so the machine needs no open ports and works behind NAT.
- You get a stable HTTPS hostname with certificates Cloudflare manages. WebSockets work.
- Cloudflare Access can turn strangers away at the edge before they reach the bridge. The Zero Trust free plan covers 50 users.
- The phone needs no VPN app. iOS runs one VPN at a time, so Tailscale can't run beside a proxy app.

Disadvantages:

- A named tunnel needs a domain on Cloudflare DNS, about $10 a year. [Quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) on `trycloudflare.com` need no domain, but the URL changes on every restart, there is no SLA, they allow 200 in-flight requests, and Cloudflare says they're for testing only.
- Cloudflare terminates TLS, so it sees plaintext unless the bridge and phone keep Noise on top.
- The bridge sits on a public hostname. Without Access, every scanner reaches it, and the bridge's own pairing check is the only gate.
- Access suits native apps better than the web. A native WebSocket can send service-token headers. A browser WebSocket can't, so the web client needs Access's cookie login.
- Each machine needs its own `cloudflared` and hostname.
- Every user needs their own Cloudflare account and domain, so a tunnel can't back an app you ship to other people.
- Cloudflare's mainland China network is for Enterprise customers with an ICP filing. Other accounts serve mainland visitors from outside China.

### Running the relay for free

The Durable Object relay runs on the Workers Free plan at no cost, on a free `workers.dev` hostname or your own domain. Budget for 100,000 incoming messages a day:

- Attach a terminal only while the app is in the foreground and that terminal is on screen. List screens need only status events.
- Batch bridge output every 100 to 250 ms, which caps a busy terminal at 4 to 10 messages a second. A quiet terminal sends nothing.
- Send CREDIT every 64 KiB consumed, not per frame.
- Keep the bridge-to-relay connection alive with protocol pings, which are free. When the app goes to the background, close the socket and rely on push, which goes through Expo and never touches the relay.
- Count messages in the bridge and drop to status-only when the day's count nears the cap.

At 10 messages a second that's about 2.5 hours of busy terminal output a day. At 4 a second it's 6 to 7 hours. Duration isn't the constraint: one Durable Object awake all day bills 128 MB × 86,400 s ≈ 11,059 GB-s, under the 13,000 GB-s daily allowance. When the cap is hit, the relay fails until 00:00 UTC.

Other free routes:

- **A free VM.** Run the Elixir relay on Oracle Cloud Always Free. Oracle cut the free Ampere A1 allowance to 2 OCPUs and 12 GB in June 2026, and it reclaims Always Free instances whose CPU, network and memory stay low for a week, which describes a relay most of the time.
- **Tailscale instead of a relay.** The free Personal plan allows 6 users with unlimited devices for non-commercial use, and falls back to Tailscale's own DERP relays when a direct path fails. The phone must run Tailscale, which takes iOS's single VPN slot.
- **Not `relay.paseo.sh`.** It speaks the same protocol, but Paseo pays for it. Don't build on it without the maintainer's agreement.

The relay can be free; the app can't be entirely. iOS distribution needs the Apple Developer Program at $99 a year. The free paths are the web build and Android APKs.

### Recommendation

Start with the Durable Object relay on the Workers Free plan, the budget above, and the five fixes. If the cap gets in the way, move to Workers Paid at $5 a month; nothing else changes. Use a tunnel for a quick personal setup with no relay code.

## Appendix: protocol notes

These are the details you need when writing `hc-client` and the bridge. Check them against the current schema before relying on them.

### herdr-core wire protocol

From [schema/README.md](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md), protocol generation 1:

- A connection starts in plain mode: JSON-RPC 2.0, one message per line. Errors carry a stable `data.kind` and a `hint`.
- `hello` with `{"framed": true}` switches the connection to framed mode after its reply. Attach needs framed mode.
- Frame layout is `[channel u32 LE][kind u8][len u32 LE][payload]`, with the payload at most 16 MiB. Channel 0 carries JSON-RPC both ways.

| kind | name   | payload                                                       |
| ---- | ------ | ------------------------------------------------------------- |
| 0    | DATA   | channel 0: one JSON-RPC message; other channels: stream bytes |
| 1    | CREDIT | u32 LE, bytes the receiver consumed                           |
| 2    | CLOSE  | the channel is over; from core, a JSON reason                 |
| 3    | RESIZE | viewer to core: u16 LE cols, u16 LE rows                      |
| 4    | FOCUS  | viewer to core: 1 gained focus, 0 lost it                     |
| 5    | FACTS  | viewer to core: JSON display facts                            |

- `terminal.attach {terminal, cols, rows, observe?, history?, display?, resumed?}` returns a channel. Core first sends the current screen, optional history, and the latest status and title, then the raw program output. The viewer sends keys as DATA on the same channel.
- Each stream starts with 256 KiB of credit. The viewer sends CREDIT for the bytes it has written out. A viewer more than 4 MiB behind gets a repaint. A stalled stream never blocks channel 0.
- To detach, send CLOSE; core answers with an empty CLOSE. When the program ends, core sends CLOSE with `{"reason":"exited","exit_code":0,"signal":null}`.
- `events.subscribe {terminal?, children_of?, labels?}` replies with `{seq, terminals}`. Notifications are `event {seq, type, terminal, data}`, `heartbeat {seq}` every 15 s, and `missed {seq, terminals}`. Drop events whose `seq` is not above the latest snapshot. `seq` restarts with each core process, so take a fresh snapshot after reconnecting.
- Event types are `created`, `lost`, `restarted`, `keep`, `finished`, `removed`, `status`, `turn`, `title`, `labels`, `size`, `foreground` and `doc`.
- A 7501 status record has `state`, `kind`, `progress`, `app`, `title` and `msg`. `kind` is permission, question or auth, and only appears on blocked records. The `Terminal` record carries `status`, `status_ms`, `turn`, `title`, `labels`, `foreground`, `parent`, `state` and exit details.
- `doc.get {name}` and `doc.set {name, value, version}` store opaque JSON with version checks, up to 1 MiB per value. herdr-app keeps its layout in the document named `herdr-app`. Doc events carry only the name and version.
- On Unix the socket is `<session>.sock` under `$XDG_RUNTIME_DIR/herdr-core/` when that is set, then `/run/user/<uid>/herdr-core/` if it exists, then the session's state directory `~/.local/state/herdr-core/<session>/`. `HC_SOCKET` overrides it. Prefer `hc connect` over hard-coded paths.

### herdr 0.9 TUI API, for comparison

- The API socket is `~/.config/herdr/herdr.sock`, with 102 methods and 27 subscription types, including `pane.agent_status_changed`. The TUI client uses a second socket, `herdr-client.sock`.
- There is no raw output stream, so Collie and Nenu poll `pane.read` whenever an event says something changed.

### Paseo relay

From `docs/relay-endpoint-security.md` and `packages/relay/src/cloudflare-adapter.ts` in the Paseo checkout:

- Relay v2 has three socket shapes per `serverId`. `role=server` without a `connectionId` is the daemon control socket, one per server. `role=server&connectionId=...` is a daemon data socket, one per connection. `role=client&connectionId=...` is a client socket, and one connection can have several.
- The handshake is `Noise_NK_25519_ChaChaPoly_SHA256` with prologue `paseo-relay-e2ee/1`. Noise message 1 rides in the client's `e2ee_hello` and message 2 in the daemon's `e2ee_ready`. The client resends hello every second until ready arrives. Credentials go in the application `hello` only after message 2 verifies the daemon.
- Each chunk's plaintext is `kind(1) || flags(1) || totalLength(u32 BE) || data`, with at most 65513 data bytes per chunk. On the wire a record is one or more `u16 BE length || ciphertext` pairs. Any bad tag, duplicate or reordered record closes the channel.
- The client closes with `4002` when it lands in legacy mode against a daemon that supports protected mode, and with `4003` on a record failure.
- The pairing offer is `{v: 2, serverId, daemonPublicKeyB64, relay: {endpoint, useTls?}, minimumSecurityMode?: "protected"}`, base64url-encoded in the `#offer=` URL fragment.
- Push is a POST to `https://exp.host/--/api/v2/push/send` in batches of 100. Tokens are leased for 48 h, and the daemon revokes tokens Expo reports as invalid.

## References

- herdr-core: [API and connection modes](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md), [OpenRPC schema](https://github.com/herdrdev/herdr-core/blob/master/schema/hc.openrpc.json), [security](https://github.com/herdrdev/herdr-core/blob/master/docs/security.md), [machines](https://github.com/herdrdev/herdr-core/blob/master/docs/machines.md). Its tests include a protocol client in `crates/herdr-core/tests/common/framed.rs` and a fake agent that reports status in `crates/herdr-core/tests/fake_tui.py`.
- herdr-app's [defaults/AGENTS.md](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md) explains spaces, tabs and labels. [herdr-core#15](https://github.com/herdrdev/herdr-core/issues/15) discusses putting the agent's session id in status reports, which the chat view would need to find the right transcript.
- Nenu's [HERDR_API.md](https://github.com/frizynn/nenu/blob/main/HERDR_API.md) records the herdr 0.9 socket behavior its bridge relies on.
- [Happy](https://github.com/slopus/happy) is an open-source encrypted mobile client for Claude and Codex. [sshx](https://github.com/ekzhang/sshx) shares terminals end-to-end encrypted through a relay. [ghostty-web](https://github.com/coder/ghostty-web) runs Ghostty in the browser with xterm.js's API. herdr also uses Ghostty's terminal engine.

## Sources

- [A Terminal Protocol for Program Status (OSC 7501)](https://mitchellh.com/writing/program-status-osc7501)
- [spaces PR #921, Claude Code and Codex versions](https://github.com/yogesh-dhande/spaces/pull/921)
- [wmux PR #2836, Claude Code startup query](https://github.com/openwong2kim/wmux/pull/2836)
- [herdr discussion #5106](https://github.com/herdrdev/herdr/discussions/5106)
- [herdrdev/herdr](https://github.com/herdrdev/herdr)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare changelog: WebSocket message size raised to 32 MiB](https://developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit)
- [Paseo #376, relay pending frames buffer](https://github.com/getpaseo/paseo/issues/376)
- [GDIndex #206, workers.dev SNI blocking report](https://github.com/maple3142/GDIndex/issues/206)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Community, Free quota blocking below 100k after 20:1](https://community.cloudflare.com/t/durable-objects-free-quota-block-below-100k-after-websocket-20-1-adjustment/967650)
- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)
- [InfoQ, Oracle Cloud free tier limits](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)
- [Tailscale free plan summary](https://costbench.com/software/business-vpn/tailscale/free-plan)
- [Tailscale Serve, including identity headers](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale, enabling HTTPS and the public ledger](https://tailscale.com/kb/1153/enabling-https)
- [OpenClaw, Tailscale identity for WebSocket auth](https://docs.openclaw.ai/gateway/tailscale)
