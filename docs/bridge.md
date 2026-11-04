# Running the bridge

`herdr-bridge` runs beside herdr-core on the Mac that owns the agent sessions. It listens only on
`127.0.0.1` and expects Tailscale Serve to provide HTTPS and the `Tailscale-User-Login` identity
header. Every phone also needs a device token issued by pairing.

## Build and start

Before the first run, follow the [isolated scratch-core procedure](smoke-checklist.md#prepare-an-isolated-run). It follows the bridge's child environment rules and the scratch setup in `prototype.md`; this build has not verified end-to-end app isolation. The commands below are normal-use instructions for after the isolated first run passes. They omit `--session` and use the usual Herdr core.

Run these commands from the repository root. Expo's CLI and Metro use Node 24.

```sh
bun run build:web
bun run bridge serve \
  --owner you@example.com \
  --port 8787 \
  --web packages/app/dist \
  --hc ~/.local/bin/hc \
  --herdr-app ~/.local/bin/herdr-app
```

The owner value must match the login Tailscale Serve adds to requests. If `--public-url` is omitted,
the bridge reads `Self.DNSName` from `tailscale status --json` and removes its trailing dot. The
default port is `8787`; the bind host is always `127.0.0.1`. `--whois` additionally checks the
forwarded peer address with `tailscale whois`.

The `build:web` script writes `packages/app/dist/index.html` and its assets. The `--web` value selects
that build directory. The bridge checks identity before it serves any file. It returns the built
`index.html` for app routes that do not match a file.

Expose the local bridge to the tailnet with Tailscale Serve:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Never use `tailscale funnel`. Funnel would publish the bridge to the public internet, and those
requests do not carry the trusted Tailscale identity header.

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
expires in ten minutes and can be tried five times. The phone receives its long-lived token once;
revoke the device from the Mac if the phone is lost. Stop the bridge before editing `devices.json`
by hand because a running bridge rewrites the file from memory.

Open the link in a browser or scan its QR code from the app's Pair screen. You can also enter the
bridge URL and code by hand. The link stores pairing data in the `#pair=` fragment, which the browser
does not send to the bridge.

If the process was force-killed and left `admin.sock` behind, first confirm the bridge is stopped,
then remove that socket file before restarting. Normal shutdown removes it automatically.

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

Run the `tailscale serve` command once for the selected port. When changing `--port`, update both
the launch agent and the Serve target. Do not configure Funnel.

For the first app run, use the wrapper and scratch bridge state in the
[smoke checklist](smoke-checklist.md#prepare-an-isolated-run). Setting XDG directories only on the
bridge command does not isolate the core because the bridge drops them before starting `hc connect`.
The integrated build has not been run on a simulator, device or browser yet.
