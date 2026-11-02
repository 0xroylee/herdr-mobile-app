# Running the bridge

`herdr-bridge` runs beside herdr-core on the Mac that owns the agent sessions. It listens only on
`127.0.0.1` and expects Tailscale Serve to provide HTTPS and the `Tailscale-User-Login` identity
header. Every phone also needs a device token issued by pairing.

## Start it

Build the web app first, then start the bridge from the repository root:

```sh
(cd packages/app && EXPO_OFFLINE=1 bunx expo export --platform web --output-dir dist)
bun packages/bridge/scripts/bridge.ts serve \
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
bun packages/bridge/scripts/bridge.ts pair --name "Desk phone"
bun packages/bridge/scripts/bridge.ts pair --watch --name "Wall display"
bun packages/bridge/scripts/bridge.ts devices
bun packages/bridge/scripts/bridge.ts devices revoke <device-id>
bun packages/bridge/scripts/bridge.ts status
```

Pairing prints a terminal QR and a link. The QR contains the HTTPS URL and a one-time code that
expires in ten minutes and can be tried five times. The phone receives its long-lived token once;
revoke the device from the Mac if the phone is lost. Stop the bridge before editing `devices.json`
by hand because a running bridge rewrites the file from memory.

If the process was force-killed and left `admin.sock` behind, first confirm the bridge is stopped,
then remove that socket file before restarting. Normal shutdown removes it automatically.

`herdr-app ls` and the `space.new` / `tab.new` actions require a control-role device. The bridge
calls the configured `herdr-app` executable directly, with a ten-second deadline. A watch-role
device cannot invoke those actions.

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
