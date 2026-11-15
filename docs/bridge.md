# Running the bridge

`herdr-bridge` runs beside herdr-core on the Mac that owns the agent sessions. It binds only to
`127.0.0.1` and can expose two separate listeners. The direct listener expects Tailscale Serve to
provide HTTPS and the `Tailscale-User-Login` identity header. The secure listener accepts only
`GET /ws` and authenticates the bridge with the pinned Noise key. Both routes also use a device token
issued by pairing.

## Build and start

Before the first normal run, follow the [isolated scratch-core procedure](smoke-checklist.md#prepare-an-isolated-run). It follows the bridge's child environment rules and the scratch setup in `prototype.md`. Use the commands below after the isolated checks pass. They omit `--session` and use the usual Herdr core.

Run these commands from the repository root. Expo's CLI and Metro use Node 24.

```sh
bun run build:web
bun run bridge serve \
  --owner you@example.com \
  --port 8787 \
  --secure-port 8788 \
  --web packages/app/dist \
  --hc ~/.local/bin/hc \
  --herdr-app ~/.local/bin/herdr-app
```

The owner value must match the login Tailscale Serve adds to requests. If `--public-url` is omitted,
the bridge reads `Self.DNSName` from `tailscale status --json` and removes its trailing dot. The
direct listener defaults to port `8787`; the bind host is always `127.0.0.1`. `--secure-port 8788`
starts the separate secure listener. It trusts no request headers and returns `404` for paths other
than `/ws`. `--whois` additionally checks the forwarded peer address with `tailscale whois`.

On startup, the CLI prints `Bridge listening on 127.0.0.1:8787` and `Admin socket: <path>`.

The `build:web` script writes `packages/app/dist/index.html` and its assets. The `--web` value selects
that build directory. The bridge checks identity before it serves any file. It returns the built
`index.html` for app routes that do not match a file.

Expose the local bridge to the tailnet with Tailscale Serve:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Never use `tailscale funnel`. Funnel would publish the bridge to the public internet, and those
requests do not carry the trusted Tailscale identity header.

## Use the secure listener

The secure listener does not use the Tailscale identity header. It accepts a WebSocket upgrade at
`/ws`, completes `herdr secure channel v1`, then accepts a device token or pairing code inside the
encrypted channel. The app pins the bridge's public key. A wrong key closes with `4003`, and the app
asks the user to pair again. API calls travel inside the channel; a direct HTTP request to
`/api/health` on the secure listener returns `404`.

**Needs your go-ahead:** starting `cloudflared` makes the secure listener reachable through
Cloudflare. Complete the approval-gated [Quick Tunnel startup steps](secure-route.md#start-the-tunnel-and-pair)
before running these admin commands to advertise its random hostname:

```sh
herdr-bridge secure url --from-cloudflared
herdr-bridge pair
```

`herdr-bridge secure url --from-cloudflared [host:port]` reads cloudflared's local metrics endpoint
and updates the in-memory secure URL. The optional `host:port` overrides the default metrics ports.
`herdr-bridge pair` then prints a v2 link and QR code. The link includes the direct route when
available, the secure route when set, and the bridge public key. The secure URL becomes the link
base. After a Quick Tunnel restart, update the secure URL before creating a new link. A fresh link
with the same pinned key changes only the secure route. It keeps the direct route and token.

You can also set an origin directly or clear it:

```sh
herdr-bridge secure url https://bridge.example.com
herdr-bridge secure url --clear
```

`https://` works for any host. Plain `http://` is allowed only for loopback and private-network
hosts. On success, the CLI prints `Secure URL set to <origin>`. The clear command prints
`Secure URL cleared.` Use [Set up the secure route](secure-route.md) for the Quick Tunnel steps, the
ClashFX and phone proxy rules, and the named-tunnel configuration.

`--public-url` follows a stricter rule. It accepts `https://` for any host and `http://` only for
loopback hosts such as `127.0.0.1`, `::1` or `localhost`. It rejects private-network HTTP because the
direct route would send the device token over the LAN in plaintext.

## Pair and manage devices

Use the local admin socket. It is created as `admin.sock` inside
`$XDG_STATE_HOME/herdr-bridge` (default `~/.local/state/herdr-bridge`); its directory is mode
`0700` and the socket is mode `0600`. The device file is `devices.json` in that directory and stores
token hashes, not the phone's token.

```sh
bun run bridge pair --name "Desk phone"
bun run bridge pair --watch --name "Wall display"
bun run bridge devices
bun run bridge devices revoke <device-id>
bun run bridge status
```

Pairing prints a terminal QR and a link. The QR contains the HTTPS URL and a one-time code that
expires in ten minutes and can be tried five times. A v2 link also carries the bridge's public key
and the secure URL when one is set. The phone receives its long-lived token once; revoke the device
from the Mac if the phone is lost. Stop the bridge before editing `devices.json` by hand because a
running bridge rewrites the file from memory.

Open the link in a browser or scan its QR code from the app's Pair screen. You can also enter the
bridge URL and code by hand. The link stores pairing data in the `#pair=` fragment, which the browser
does not send to the bridge.

If the process was force-killed and left `admin.sock` behind, first confirm the bridge is stopped,
then remove that socket file before restarting. Normal shutdown removes it automatically.

`herdr-bridge status` reports the bridge public key and the secure listener's port, URL, session
count and handshake failure count. `herdr-bridge identity` prints the public key. The identity
secret stays in the private bridge state directory. `herdr-bridge identity rotate` replaces the key
and closes secure sessions with code `1012`. It prints
`Bridge identity rotated. Secure-only devices must pair again. Public key: <key>`. The bridge logs
secure session opens, closes and handshake failures, but never logs payloads, device tokens, pairing
codes or identity keys.

`herdr-app ls` and the `space.new` / `tab.new` actions require a control-role device. The bridge
calls the configured `herdr-app` executable directly, with a ten-second deadline. A watch-role
device cannot invoke those actions.

## Start agents from a phone

Only control devices can use `GET /api/agents/catalog` and `POST /api/agents/start`. The catalog
lists Claude Code (`claude`), Codex (`codex`), programs added with `--run-program <name>`, and
templates returned by herdr-core. A request names one program or template. It cannot contain shell
lines or extra program arguments.

The bridge accepts folders under the home folder or a `--run-root <dir>`. It resolves the requested
folder and checks it by real path. That folder check has a ten-second deadline. `AllowedRoots`
resolves configured roots lazily on first use, with a five-second deadline per root. A missing or
stalled root keeps its configured spelling in the catalog. It never delays bridge startup, holds the
catalog past the root deadline, or prevents another root from authorizing a folder.

When `herdr-app ls` succeeds, the bridge uses `herdr-app do space.new` for a new space or
`herdr-app do tab.new` for an existing space. Each call passes one JSON object with the folder,
program and optional first message. The existing-space call also carries the space id. Herdr receives
the first message through the `task` field.

When the Herdr window is closed, the bridge uses herdr-core's `terminal.run` through a short-lived
`hc connect` call. It sets `keep: true` and labels the terminal with `herdr.space`, `herdr.tab` and
`herdr-mobile.origin`. The phone reports `Started in herdr-core. Herdr shows it when it opens.`

Built-in programs, including programs added with `--run-program`, need Herdr open to receive a first
message. If the window is closed, the bridge refuses that start with HTTP 422 and
`First messages for <program> need Herdr open on your Mac. Open Herdr, or leave the message empty.`
Templates use herdr-core's
template first-message path when they start in core. In this path, `AgentStarter` passes the task as
the second item in `terminal.run`'s `argv`; scratch verification confirmed that herdr-core delivers
it as the template's first message. Built-in task text is not added to a program's `argv`.

In the 2026-11-04 scratch verification, `hc templates --help` named
`~/.config/herdr-core/templates`. The checked format was a `.md` file with front matter fields
`description` and `command`, followed by a body. herdr-core did not read `.toml` or `.json` files.

After a successful start, the bridge writes one `Agent started` line with JSON fields for time,
device id, name and role, run, canonical folder, placement, optional address, space and tab. It does
not include the first message or device token.

## Launch at login with launchd

Save this as `~/Library/LaunchAgents/dev.herdr.bridge.plist`, replacing `your-user` with the short
name of your home folder and replacing the owner login. launchd does not expand `~`, so use absolute
paths. Launch agents run as the logged-in user, which lets the bridge reach that user's herdr-app
window and state directory.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.herdr.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>/Users/your-user/src/herdr-mobile-app/packages/bridge/scripts/bridge.ts</string>
    <string>serve</string>
    <string>--owner</string>
    <string>you@example.com</string>
    <string>--port</string>
    <string>8787</string>
    <string>--secure-port</string>
    <string>8788</string>
    <string>--web</string>
    <string>/Users/your-user/src/herdr-mobile-app/packages/app/dist</string>
    <string>--hc</string>
    <string>/Users/your-user/.local/bin/hc</string>
    <string>--herdr-app</string>
    <string>/Users/your-user/.local/bin/herdr-app</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/your-user/src/herdr-mobile-app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/your-user/Library/Logs/herdr-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/your-user/Library/Logs/herdr-bridge-error.log</string>
</dict>
</plist>
```

Load it into the current user's launchd session:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.herdr.bridge.plist
```

For a named tunnel, add `--secure-url` and its HTTPS origin to the bridge's `ProgramArguments`,
after `--secure-port 8788`. For example, add `--secure-url` and `https://bridge.example.com` as two
separate string entries. Do not set a Quick Tunnel URL in this plist because it changes after a
restart.

Run the `tailscale serve` command once for the selected port. When changing `--port`, update both
the launch agent and the Serve target. Do not configure Funnel.

For the first app run, use the wrapper and scratch bridge state in the
[smoke checklist](smoke-checklist.md#prepare-an-isolated-run). Setting XDG directories only on the
bridge command does not isolate the core because the bridge drops them before starting `hc connect`.
The integrated build has not been run on a simulator, device or browser yet.
