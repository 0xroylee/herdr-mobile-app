# Set up the secure route

The secure route lets the phone reach the bridge while Tailscale is off. `cloudflared` carries the
connection to the Mac. The Noise channel authenticates the bridge and encrypts app traffic end to
end, so Cloudflare sees ciphertext. The bridge keeps the Tailscale route as a separate option.

The bridge binds both listeners to `127.0.0.1`. The direct listener uses port `8787` by default and
checks the Tailscale identity header. The secure listener uses the port passed to `--secure-port`,
usually `8788`. It trusts no headers and accepts only `GET /ws`. It returns `404` for `/api` and
every other path. The app sends API calls inside the Noise channel. Never expose the bridge with
`tailscale funnel`.

The secure listener does not serve the web app. It carries only `/ws`; the bridge serves web files
through the direct listener. Use the native app for the phone's secure route. The browser checks in
the [smoke checklist](smoke-checklist.md#secure-route-on-an-isolated-bridge) use Expo's local
development server.

Run each step marked **Needs your go-ahead** only after the user approves that step. These steps
install software, start or stop a service, change network settings, write Mac files, change a bridge
identity, or touch a Cloudflare account, DNS zone or domain.

The examples use the installed `herdr-bridge` command. From a source checkout, prefix each bridge
command with `bun run bridge`, for example `bun run bridge serve`.

## Phase 1: test with a Quick Tunnel

A Quick Tunnel needs no Cloudflare account or domain. It gives you a random `trycloudflare.com`
hostname. The hostname changes when you create a new tunnel, and Cloudflare gives Quick Tunnels no
uptime guarantee. Use one for testing and development.

### Prepare the Mac

1. **Needs your go-ahead: check for cloudflared config files.** Quick Tunnels do not start when
   either `~/.cloudflared/config.yml` or `~/.cloudflared/config.yaml` exists. Do not delete or move
   an existing file without the user's go-ahead.

   ```sh
   for config in "$HOME/.cloudflared/config.yml" "$HOME/.cloudflared/config.yaml"; do
     if [ -e "$config" ]; then
       printf 'Quick Tunnel blocked by existing config: %s\n' "$config"
       exit 1
     fi
   done
   ```

   If either file exists, stop here and ask the user what to do. Any move or removal still needs
   the user's go-ahead.
2. **Needs your go-ahead: install cloudflared.**

   ```sh
   brew install cloudflared
   ```

3. **Needs your go-ahead: start or update the bridge.** Include `--secure-port 8788`. Keep the
   existing `--owner`, `--web`, `--hc` and `--herdr-app` values for this Mac.

   ```sh
   herdr-bridge serve --owner you@example.com --port 8787 --secure-port 8788 \
     --web /path/to/packages/app/dist --hc /path/to/hc --herdr-app /path/to/herdr-app
   ```

   The CLI prints `Bridge listening on 127.0.0.1:8787` and the path to its admin socket.
   Do not set `--secure-url` for a Quick Tunnel. The CLI reads its temporary hostname from
   cloudflared after the tunnel starts.

### Start the tunnel and pair

Run these commands in order. Keep the cloudflared terminal open while you use the secure route.

1. **Needs your go-ahead: start cloudflared.** This makes the secure listener reachable from the
   internet through Cloudflare.

   ```sh
   cloudflared tunnel --url http://127.0.0.1:8788 --metrics 127.0.0.1:20241 --protocol http2 --edge-ip-version 4
   ```

   Wait for cloudflared to print its `trycloudflare.com` address. The `http2` and IPv4 options keep
   the tunnel on TCP instead of QUIC.
2. **Needs your go-ahead: advertise the tunnel address.** The CLI reads the local metrics endpoint
   and sets the bridge's in-memory secure URL.

   ```sh
   herdr-bridge secure url --from-cloudflared
   ```

   The CLI checks ports `20241` through `20245` on `127.0.0.1` unless you pass a different
   `host:port`. On success, it prints `Secure URL set to https://<hostname>`.
3. **Needs your go-ahead: create a pairing link.**

   ```sh
   herdr-bridge pair
   ```

   The output includes `Pair link: https://<random>.trycloudflare.com/#pair=...` and a terminal QR
   code. The v2 link carries the secure URL, the bridge's public key and a one-time code. When the
   secure URL is set, it is the link's base.
4. **Needs your go-ahead: scan the QR code on the iPhone.** Open Pair in the app, turn Tailscale off
   on the phone, and keep the proxy app on. Confirm that the app connects through the secure route.
   The Mac's Tailscale connection can stay on for the direct route.

### Refresh the link after a tunnel restart

A Quick Tunnel gets a new hostname when it restarts. A paired app keeps the address it already has,
so refresh the advertised address before you make a fresh link.

1. **Needs your go-ahead: stop and restart cloudflared** with the same command above.
2. **Needs your go-ahead: update the bridge URL before pairing again.**

   ```sh
   herdr-bridge secure url --from-cloudflared
   ```

3. **Needs your go-ahead: create a fresh link and scan it again.**

   ```sh
   herdr-bridge pair
   ```

   Open the new link or scan its QR code. If the bridge key `k` matches the key already stored for
   this Mac, the app updates only `routes.secure`. It keeps the direct route, token and pinned key.
   It does not redeem the link's pairing code or add another device.

### Quick Tunnel limits

- Quick Tunnels are for testing and development. They have no uptime guarantee and the hostname
  changes after a restart.
- Cloudflare allows up to 200 in-flight requests per Quick Tunnel. Requests over that limit receive
  `429`. A WebSocket counts as one request when it upgrades and stays open for the session. Quick
  Tunnels do not support Server-Sent Events; the app uses WebSockets.
- Cloudflare supports proxied WebSockets without extra configuration. The app pins and authenticates
  the bridge's Noise key, then sends its device token or pairing code. The bridge authenticates the
  device with that token or code.
- The bridge allows at most 64 handshakes at once and gives each handshake a 10-second deadline.
  Pairing codes allow five attempts and expire after ten minutes. The bridge has no per-IP limiter.
  Check `handshakeFailuresLastHour` in `herdr-bridge status` if you suspect abuse.
- A Quick Tunnel has no Cloudflare zone, so it has no Cloudflare rate-limiting rule. The domain
  phase below adds one for a named tunnel.

## Set the network rules

The phone's proxy app sees a normal `wss://` connection. Keep the tunnel hostname on one route so a
proxy-mode switch does not drop the connection.

- **Needs your go-ahead: change the phone's proxy rule** if you want to pin `*.trycloudflare.com`
  to either proxy or direct. For the named tunnel, use its hostname instead.
- **Needs your go-ahead: change ClashFX rules** only if the Mac's TUN routing needs it.

In TUN mode, Clash captures cloudflared's edge traffic. `cloudflared` ignores `HTTPS_PROXY`. The
commands above force HTTP/2 over IPv4 because QUIC over a proxy node is often the first connection
to fail. If Clash routes Cloudflare's edge directly and that route is slow, add `*.argotunnel.com`
and `*.cftunnel.com` to a TCP-capable proxy node. The TUN route-exclude mixin needs no change unless
it excludes Cloudflare edge ranges.

In system-proxy mode, nothing captures `cloudflared`; it connects directly to Cloudflare's edge. That
works from mainland China but may be slow. Cloudflare serves non-Enterprise hostnames outside China,
so the phone can reach a named tunnel through its proxy or directly at a lower speed.

## Phase 2: use a domain and a named tunnel

The named tunnel keeps one hostname across restarts. It uses the same secure listener and Noise
channel as the Quick Tunnel. Every item below changes the Mac or Cloudflare settings and needs the
user's go-ahead.

1. **Needs your go-ahead: use a domain in Cloudflare DNS.** Choose a domain already in the user's
   Cloudflare account or add one there.
2. **Needs your go-ahead: log in and create the tunnel.** `cloudflared tunnel login` opens a browser
   to authorize the Cloudflare account. Then create the named tunnel and its DNS record.

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create herdr
   cloudflared tunnel route dns herdr bridge.example.com
   ```

   Record the tunnel ID and credentials file path printed by `cloudflared tunnel create`.
3. **Needs your go-ahead: write the cloudflared config.** Copy
   [`cloudflared.example.yml`](../packages/bridge/deploy/cloudflared.example.yml) to
   `~/.cloudflared/config.yml`. Replace its tunnel ID, credentials path and hostname with the
   values from the previous step.
4. **Needs your go-ahead: install the cloudflared LaunchAgent.** Copy
   [`com.herdr.cloudflared.plist`](../packages/bridge/deploy/com.herdr.cloudflared.plist) to
   `~/Library/LaunchAgents/com.herdr.cloudflared.plist`. Update the Homebrew path, username and log
   paths. Then load it into the logged-in user's launchd session.

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.herdr.cloudflared.plist
   ```

5. **Needs your go-ahead: start or update the bridge with the stable URL.** Add both flags to the
   bridge's LaunchAgent, or start it with the same values. See [Running the bridge](bridge.md) for
   the bridge LaunchAgent.

   ```sh
   herdr-bridge serve --owner you@example.com --port 8787 --secure-port 8788 \
     --secure-url https://bridge.example.com --web /path/to/packages/app/dist \
     --hc /path/to/hc --herdr-app /path/to/herdr-app
   ```

6. **Needs your go-ahead: add the Cloudflare rate-limiting rule.** The Free plan allows one rule.
   Match the path `http.request.uri.path eq "/ws"`, count by IP over 10 seconds, block at 10
   requests, and set the mitigation timeout to 10 seconds. The Free plan exposes Path and Verified
   Bot as expression fields and IP as the counting characteristic.
7. **Needs your go-ahead: set the phone proxy rule** to keep `bridge.example.com` on one route.
8. **Needs your go-ahead: create a new pairing link** after the bridge and tunnel are running.

   ```sh
   herdr-bridge pair
   ```

The example cloudflared LaunchAgent starts the named tunnel with HTTP/2 and IPv4. The bridge
LaunchAgent advertises `https://bridge.example.com` with `--secure-url`, so a tunnel restart does not
change the app's address.

## Check the route and recover

Run `herdr-bridge status` to inspect the advertised route. The JSON includes `bridgeKey` and
`secure: {port, url?, sessions, handshakeFailuresLastHour}`. `url` is absent until you set it. The
public key is not the secret identity key.

If the phone cannot connect, check that the bridge and cloudflared are running and that
`herdr-bridge status` shows the expected secure URL. If a Quick Tunnel restarted, update its URL and
make a fresh link as described above. A link for a matching pinned key changes only the secure route.
If the identity key changed, the app reports that the bridge identity changed and asks you to pair
again.

For a stopped named tunnel, **get the user's go-ahead before restarting its LaunchAgent**. This
stops any current cloudflared process and starts it again.

```sh
launchctl kickstart -k gui/$(id -u)/com.herdr.cloudflared
```

The named hostname stays the same. The bridge advertises it from `--secure-url` after a bridge
restart, so the phone does not need a new link just because cloudflared restarted.

The bridge logs `Secure session opened`, `Secure session closed` and `Secure handshake failed` with
session counts, byte counts, device details, a close code or a failure reason, and the edge-reported
IP when available. They never contain a payload, device token, pairing code or identity key.

**Needs your go-ahead: rotate the bridge identity** only when you intend to replace its key. The
command closes every secure session with code `1012` and prints the new public key. Direct-route
devices learn the new key on their next connection. Secure-only devices must pair again.

```sh
herdr-bridge identity rotate
```

To inspect the current public key without rotating it, run `herdr-bridge identity`. It prints the
public key. To pair a device again after rotation, create and scan a new link with
`herdr-bridge pair`.
