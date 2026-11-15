# First-run smoke checklist

Run the isolated sections before checks that use a real Mac or device. Record failures with the
platform, OS version and screen where they occur.

## Prepare an isolated run

- [ ] Use this procedure for the first run. It follows the bridge's child environment rules and the scratch setup in [prototype.md](prototype.md); end-to-end isolation for this app has not been verified. Run it from the repository root in one terminal where `hc`, `bun` and `tailscale` are on `PATH`. Keep that shell open so `root` and `session` remain available.

  ```sh
  root=$(mktemp -d /tmp/herdr-smoke-XXXXXX)
  session="herdr-smoke-$(date +%s)-$$"
  mkdir -p "$root/home" "$root/run" "$root/state" "$root/config"
  cat > "$root/hc-scratch" <<EOF
  #!/bin/sh
  exec /usr/bin/env -i \
    PATH="\$PATH" \
    LANG="\${LANG:-en_US.UTF-8}" \
    LC_ALL="\${LC_ALL:-}" \
    HC_SESSION="\${HC_SESSION:?set HC_SESSION to the recorded smoke session}" \
    HOME="$root/home" \
    XDG_RUNTIME_DIR="$root/run" \
    XDG_STATE_HOME="$root/state" \
    XDG_CONFIG_HOME="$root/config" \
    hc connect
  EOF
  cat > "$root/herdr-app-stub" <<'EOF'
  #!/bin/sh
  printf '%s\n' 'herdr-app is disabled in this scratch run' >&2
  exit 1
  EOF
  chmod 700 "$root/hc-scratch" "$root/herdr-app-stub"
  printf 'Smoke root: %s\nSession: %s\n' "$root" "$session"
  ```

  Pass `--herdr-app "$root/herdr-app-stub"` to every scratch bridge command. The stub prevents
  `herdr-app` from inspecting or changing the real Herdr window. Health, devices, pairing,
  connection and terminal-record checks remain in scope. The stub makes Herdr appear closed: Start's
  catalog still lists the configured programs, templates and roots with `windowOpen: false`. Only
  actions that run `herdr-app` fail: starting in the Herdr window and creating a space or tab. Keep
  the catalog assessment and those actions out of these checks.

- [ ] Build the web app with `bun run build:web`. Confirm that `packages/app/dist/index.html` exists.
- [ ] Start the bridge with the wrapper as its `hc` executable. Set the bridge's state directory to the same scratch root so its `devices.json` and `admin.sock` are isolated too. The explicit `--session` is required because the bridge does not inherit the shell's `HC_SESSION`.

  ```sh
  XDG_STATE_HOME="$root/state" bun run bridge serve \
    --owner you@example.com \
    --port 8787 \
    --web packages/app/dist \
    --hc "$root/hc-scratch" \
    --herdr-app "$root/herdr-app-stub" \
    --run-root "$root/home" \
    --session "$session"
  ```

- [ ] In another terminal, set `root` to the printed scratch root, expose the loopback bridge with Tailscale Serve, then pair only a test device. Run every bridge admin command, including `pair`, `devices` and `status`, with the same `XDG_STATE_HOME` so it finds the scratch `admin.sock` and device store.

  ```sh
  root=/tmp/herdr-smoke-REPLACE_WITH_PRINTED_ROOT
  tailscale serve --bg --https=443 http://127.0.0.1:8787
  XDG_STATE_HOME="$root/state" bun run bridge pair --name "Smoke-test phone"
  ```

- [ ] Open the app on the test device and connect to the bridge. Confirm the connection is Connected and the Agents screen is empty before anything runs in this scratch core. If agents already appear, stop the smoke run and do not interact with them. This first check uses the wrapper's fresh session and does not inspect the default core.
- [ ] Space and tab creation are pending until an isolated `herdr-app` target is verified. The current app actions use the bridge's full environment and have no isolated target. Do not create a space or tab against the user's Herdr window.

## Tasks on an isolated scratch core

Use this section only with the root and session from [Prepare an isolated run](#prepare-an-isolated-run).
The fake programs must be on the scratch core's `PATH` before that core starts or restarts; the
bridge's own `PATH` does not control programs spawned inside the core.

- [ ] Create wrappers for Claude Code and Codex. The fake agent prints its argv, reports `working`,
  then waits at a numbered menu, accepts input, reports `working` and `done`, and exits with the
  configured code. OSC 7501 reports contain only the state; the question, menu and done message stay
  visible as terminal text.

  ```sh
  repo=$PWD
  mkdir -p "$root/bin"
  cat > "$root/fake-agent.json" <<'EOF'
  {"mode":"blocked","delayMs":400,"exitCode":0,"msg":"Scratch task finished","lastLine":"Fake agent finished the task."}
  EOF
  for agent in claude codex; do
    cat > "$root/bin/$agent" <<EOF
  #!/bin/sh
  exec env HERDR_FAKE_AGENT_CONFIG="$root/fake-agent.json" bun "$repo/packages/bridge/scripts/fake-agent.ts" "\$@"
  EOF
  done
  chmod 700 "$root/bin/claude" "$root/bin/codex"
  PATH="$root/bin:$PATH"
  ```

- [ ] Start or restart only the scratch core with this `PATH`, using the same `HC_SESSION`,
  `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` wrapper values from the isolated setup.
  Keep `--run-root "$root/home"` on the scratch bridge.
- [ ] With a control token from the test pairing, send `POST /api/tasks` to the direct listener with
  `text: "Review the scratch task"`, `run: {"kind":"program","id":"claude"}`, `folder:
  "$root/home"` and a new space. Confirm the reply has both `record` and `start`, and that the
  `Agent started` line contains `task: true` but no task text.
- [ ] Through the same scratch session wrapper, call `terminal.list`. Confirm the new terminal has
  `argv: ["claude", "--", "Review the scratch task"]`, `cwd: "$root/home"`, and the
  `herdr.space`, `herdr.tab` and `herdr-mobile.origin` labels. Read `herdr-mobile.tasks` with
  `doc.get`; confirm the record has the matching terminal address.
- [ ] For Claude Code and Codex, try a one-word task and a task beginning with `-`. Each returns 422
  `task_not_allowed` with `Write the task as a sentence.` and adds no record. Try one-word and
  dash-leading text with a template on both Herdr window and core starts; each is passed as the
  template's first message (`[name, task]` on core). NUL and text over 8 KiB are refused for every
  task. Try each task route with a watch token; each returns 403. Unknown body keys return 400.
- [ ] Check the running task with its current turn, then uncheck it. Check a terminal started outside
  the phone by its address; confirm a `herdr` record appears. Clear a space and confirm only checked
  tasks whose terminals ended or disappeared are removed, including a kept terminal with a
  non-null reason, while a running terminal remains.
- [ ] Stop and restart the scratch bridge and confirm the core document is unchanged. Restart the
  scratch core only through the wrapper's `server.stop` procedure in [Cleanup](#cleanup), reconnect
  with the same scratch session, and confirm the document survives. Never run a core stop command
  outside that scratch wrapper.
- [ ] Repeat the task calls through a paired secure channel when the secure scratch listener is in
  use. The secure listener still returns 404 for direct `/api` HTTP requests; task calls travel
  inside the channel.

## Your Mac: Herdr window and real agents

Run these checks yourself on your Mac with your own Herdr window, installed agents and phone. They
start real terminals and change your Herdr spaces. They are separate from the isolated run above.
Use a control device, keep the bridge log open, and choose folders under home or a configured
`--run-root`.

- [ ] With Herdr open, start Claude Code with a short first message in an existing space. Confirm
  that Herdr adds a tab to that space with the selected folder, and that the message reaches Claude
  through Herdr's own delivery. Confirm that the app opens the agent screen or Spaces according to
  the reply.
- [ ] With Herdr open, start a configured interactive program in a new space and choose a folder.
  Confirm the new space and tab appear in Herdr with that folder. If you enter a first message,
  confirm Herdr delivers it. Confirm that the app opens the agent screen or Spaces according to the
  reply.
- [ ] For both open-window starts, note whether the bridge calls `herdr-app do tab.new` or
  `herdr-app do space.new`. If you can safely capture the child stdout, record what its JSON output
  contains. Compare any returned space, tab and address ids with the matching `Agent started` line
  and what Herdr shows. The bridge captures the command's output rather than echoing it, so the
  normal bridge log does not show the raw JSON.
- [ ] Close Herdr. Start Codex without a first message. Confirm that the phone opens its agent screen
  and says `Started in herdr-core. Herdr shows it when it opens.`
- [ ] With Herdr still closed, start Claude Code and Codex with task sentences. Confirm both start
  in herdr-core with the task as one argv item after `--`. A program added with `--run-program`
  should still refuse a first message while Herdr is closed.
- [ ] Open Herdr. Find the Codex terminal in the space and tab named by its `herdr.space` and
  `herdr.tab` labels. Compare those ids with its `Agent started` line.
- [ ] With Herdr closed, start one template from `~/.config/herdr-core/templates` without a first
  message, then start a template with a first message. Confirm both start and that herdr-core
  delivers the latter through the template's first-message path.
- [ ] On a watch device, confirm there is no Start action in Agents or Spaces. Open `/start` directly
  and confirm it shows `This device is read-only. Starting agents is available on control devices.`
- [ ] Check the bridge log. Each successful start should have one `Agent started` line. Confirm the
  lines contain no first-message text or device token. A refused start should not add an
  `Agent started` line.

## iOS and Android simulator

Repeat these checks on both simulators.

- [ ] Cold-start the app. Confirm that the splash stays visible until boot hydration and the five fonts finish loading.
- [ ] If font loading fails, confirm that the app shows its recovery state. Select Retry after restoring the font assets and confirm that the app opens.
- [ ] Select `system`, `graphite` and `paper` themes. Confirm that the selected palette appears on each screen and `system` follows the simulator's appearance setting.
- [ ] Increase Dynamic Type to its largest accessibility setting. Confirm that labels and controls remain readable and do not clip.
- [ ] Check tab-bar spacing, borders and hit areas in both themes. Confirm that each tab remains easy to select.
- [ ] Open Agents and Spaces with enough rows to scroll. Confirm that FlashList reaches the first and last rows and remains responsive.
- [ ] Inspect agent program icons. Confirm that expo-image renders SVG icons and that missing icons leave the row usable.
- [ ] Tap shared buttons, rows and icon buttons. Confirm that hit areas are reachable and pressed feedback is visible. Check spinner motion, state fades and reduced-motion behavior.
- [ ] Open and dismiss takeover, interrupt, end-terminal and device-removal confirmations. Confirm that each native confirmation appears, dismisses and leaves data unchanged when canceled.
- [ ] Check safe areas on Agents, Agent and Settings. Confirm that content and controls stay clear of the status bar, display cutout and home indicator.
- [ ] Open the Agent composer and show the keyboard. Confirm that the composer and send controls remain visible above it and that the terminal content can still scroll.
- [ ] On a narrow simulator, inspect long labels and controls. Confirm that they wrap without clipping or overlapping adjacent content.
- [ ] Open a confirmation, then cancel it. Confirm that it dismisses and leaves the terminal, device or other target unchanged.
- [ ] Long-press an agent row that offers actions. Confirm that its action menu appears; dismiss it without choosing an action and confirm the row remains unchanged.
- [ ] Copy an agent address or pairing snippet. Confirm that the clipboard contains the displayed text and the app reports success only when the copy succeeds. If copying fails, confirm that the app shows failure feedback.
- [ ] Visit Agents, Spaces, Settings and Pair, open an Agent from Agents, then navigate back. Confirm that each route shows its own screen and Back returns to the prior screen.
- [ ] Open the machine list with several paired devices. Scroll to the last device, then select Cancel. Confirm that the list scrolls and Cancel remains reachable.
- [ ] Open a paired agent. Confirm that its screen attaches in watch mode, displays the current terminal and does not resize the Mac terminal.
- [ ] Use the key bar and composer. Confirm that keys reach the terminal, sent text appears once, and the sent state clears on the next working status or after its timeout.
- [ ] On a recognized Claude Code or Codex question, choose an answer and confirm that the corresponding keys reach the terminal. Confirm that a watch-role device can read the prompt but cannot answer it.
- [ ] Show a long recognized Claude Code or Codex prompt, set text size to the largest accessibility setting and open the keyboard. Confirm that the question, choices and composer remain readable, do not overlap or clip, and the answer controls remain usable.
- [ ] Pinch the terminal text in and out. Confirm that zoom goes down to the smaller of 8 points and the width-fitting overview, and never goes above 16 points. When that overview is below the default, double-tap to switch between overview and default; otherwise double-tap to return to default. Scroll the terminal and confirm that scrolling does not change zoom.
- [ ] Confirm Take over. Check that the app reattaches with input enabled and resizes the Mac terminal to the grid that fits at the larger of the current zoom and 8 points. Confirm that the pane's zoom stays between the smaller of 8 points and the current width-fitting overview, and 16 points, if the terminal size changes; the terminal remains visible. Cancel the confirmation once and confirm that watch mode remains active.
- [ ] Pending until a safe fixture with adjacent wrapped tabs is available: tap near both edges of neighboring tab pills and in the gap between them. Confirm each tap selects only the tab intended by its hit area, with no clipping or overlap. Do not create tabs in the user's Herdr window.
- [ ] Pending until an isolated `herdr-app` target is verified: create a space and tab and confirm that they appear in document order. Do not run this check against the user's Herdr window. The controls currently remain enabled while offline or unauthorized.
- [ ] Change theme and notification preferences, restart the app, and confirm that the choices persist. Confirm that notification switches do not send push alerts.

## Physical device

Repeat on at least one iOS or Android device. Check device-specific items that the simulator cannot cover.

- [ ] Connect the phone and Mac to the same tailnet. Open the bridge's HTTPS address. Confirm that the app reaches the paired bridge and shows the device name and connection state.
- [ ] Scan the pairing QR code. Test both camera permission paths. Confirm that the scanner opens as a sheet on iOS that a downward swipe closes, the preview appears after permission, the code is accepted once, a successful pairing opens Agents, and a denied permission still allows manual URL and code entry.
- [ ] Pair, close and reopen the app. Confirm that the device stays paired and the token remains available through SecureStore.
- [ ] Change settings and restart the app. Confirm that SQLite-backed settings persist.
- [ ] Check safe areas, touch targets, pressed feedback, haptics, fonts and maximum Dynamic Type on the device. Confirm that pinch, double-tap, scroll and takeover work with real touch input.
- [ ] Copy the pairing snippet and an agent address. Confirm that the clipboard receives the expected text and the app reports success or failure accurately.
- [ ] Background the app during a connection, then foreground it. Confirm that the connection closes or reconnects as designed, returns to Connected, and refreshes the core snapshot without stale rows.

## Browser

- [ ] Open the Tailscale HTTPS address in a browser on the tailnet. Confirm that `/` loads the exported app and that a direct app route loads through the `index.html` fallback.
- [ ] Open a `#pair=` link. Confirm that the app routes to Pair, removes the fragment from the address bar, preserves the path and query, and does not send the code in an HTTP request.
- [ ] Pair with a link and code. Confirm that the bridge connection line reaches Connected and displays the chosen device name.
- [ ] Copy the pairing snippet. Confirm that the browser clipboard result appears only when the copy succeeds and that failure has visible feedback.
- [ ] Change theme and notification preferences, reload the page, and confirm that localStorage restores them. Confirm that About explains browser token storage.
- [ ] Open and cancel confirmations. Confirm that the browser selects `Confirm.web.ts` behavior and preserves data on cancel.
- [ ] Repeat agent listing, SVG icon rendering, space scrolling, terminal attachment, key input, text send, prompt answer, zoom and takeover. Confirm that keyboard and pointer input reach the selected agent only.
- [ ] Reload while connected and after pairing. Confirm that the app restores the paired machine and reconnects, then shows an error when the scratch bridge is stopped.

Space and tab creation remain pending until an isolated `herdr-app` target is verified. Do not run those actions against the user's Herdr window.

## Secure route on an isolated bridge

Repeat the root, session and both wrapper setups in [Prepare an isolated run](#prepare-an-isolated-run)
with new values. Skip that section's bridge startup, Tailscale Serve and pairing steps. Keep the real
Herdr window, default core, Tailscale Serve and Cloudflare out of this run. Health, devices, pairing,
connection and terminal-record checks remain in scope; Start's catalog and Herdr space or tab
actions stay out. The stand-in edges bind to loopback.

- [ ] Build and serve the app in development mode. Expo's CLI and Metro use Node 24.

  ```sh
  bun run build:web
  (cd packages/app && npx expo start --web --port 8081)
  ```

  **Needs your separate go-ahead:** open the U19-5 app in the iOS simulator for the simulator checks
  below. Each later task that uses the simulator is marked separately too.

- [ ] Start the scratch bridge with both listeners. The direct URL points at the direct stand-in
  edge, which adds the required Tailscale identity header. Plain HTTP is allowed here because the
  advertised URL is loopback.

  ```sh
  XDG_STATE_HOME="$root/state" bun run bridge serve \
    --owner smoke@example.com \
    --port 8790 \
    --public-url http://127.0.0.1:9450 \
    --secure-port 8788 \
    --web packages/app/dist \
    --run-program sh \
    --run-root "$root/home" \
    --hc "$root/hc-scratch" \
    --session "$session" \
    --herdr-app "$root/herdr-app-stub"
  ```

- [ ] In another terminal, start the secure stand-in edge. Its default is `127.0.0.1:9443` to
  `127.0.0.1:8788` and it forwards `Cf-Connecting-Ip`.

  ```sh
  bun packages/bridge/scripts/stand-in-edge.ts
  ```

  Confirm it prints `Stand-in edge listening on 127.0.0.1:9443`.

- [ ] In a second terminal, set `root` to the scratch root and define an admin helper. Set the
  secure URL before you make any pairing links.

  ```sh
  root=/tmp/herdr-smoke-REPLACE_WITH_PRINTED_ROOT
  admin() { XDG_STATE_HOME="$root/state" bun run bridge "$@"; }
  admin secure url http://127.0.0.1:9443
  ```

  Confirm both requests return `404`.

  ```sh
  curl -i http://127.0.0.1:8788/api/health
  curl -i -H 'Tailscale-User-Login: smoke@example.com' http://127.0.0.1:8788/api/health
  ```

- [ ] Create a control-device link for the browser while the direct stand-in edge is stopped. The
  bridge prints a link whose `#pair=` fragment contains both routes and the bridge key. Open a new
  browser tab at `http://localhost:8081/#pair=...`, using the printed fragment unchanged. A fresh
  tab matters because changing only the `#` part of the current URL does not reload the app.

  ```sh
  admin pair --name "Scratch browser"
  ```

  Confirm the browser pairs and shows `Connected via the secure route`. If the Pair screen dismisses
  to Agents before you can read its route line, record that behavior and continue. The line is only
  visible briefly.
- [ ] From the browser control device, use Start only to create one fixture terminal: choose the
  allowed `sh` program, run it in the scratch core with no first message, and choose a folder under
  `$root/home`. The scratch-only `--run-program sh` and `--run-root "$root/home"` settings allow
  this `terminal.run` request through `hc-scratch` with the recorded session. The stub makes Herdr
  appear closed; Start's catalog still lists the configured programs, templates and roots with
  `windowOpen: false`. Only actions that run `herdr-app` fail: starting in the Herdr window and
  creating a space or tab. Keep the catalog assessment outside this fixture check. Do not choose any
  Herdr space or tab action.

  Send `printf 'CONTROL_INPUT_OK\n'` from the control device's terminal input. Confirm that the
  scratch shell prints `CONTROL_INPUT_OK`. Then stage a 1 MiB output fixture in that same terminal:

  ```sh
  yes x | head -c 1048576
  printf '\nATTACH_REPLAY_COMPLETE\n'
  ```

- [ ] **Needs your separate go-ahead:** create a watch-device link for the iOS simulator. Before
  submitting the full link in Pair, start a timer; stop it when the app first shows
  `Connected via the secure route` and record the elapsed time as the simulator's secure pairing
  handshake measurement. Do not reuse the browser's one-time code.

  ```sh
  admin pair --watch --name "Scratch simulator"
  ```

  **Needs your separate go-ahead:** open the scratch terminal on the simulator and time from opening
  it until the screen first renders; record this as the simulator's terminal first-paint measurement.
  Confirm `ATTACH_REPLAY_COMPLETE` is visible on the current screen. The 1 MiB attach-replay
  measurement remains pending: the app omits `history` from attach requests, so it receives the
  current screen rather than the preceding 1 MiB of output. Confirm the watch device can read the
  terminal records but cannot send input. If input controls are visible, try sending
  `printf 'WATCH_INPUT_SHOULD_NOT_ARRIVE\n'`; the shell must not receive it. If controls are absent,
  record that read-only refusal. Do not test Start's catalog or Herdr space/tab actions.
- [ ] **Needs your separate go-ahead:** stop the secure stand-in edge with Ctrl+C. Confirm both
  clients show `Reconnecting…`. Start it again with the same command. Confirm both clients reconnect
  through the secure route.
- [ ] **Needs your separate go-ahead:** start the direct stand-in edge in another terminal and force
  the simulator to reconnect. The
  stand-in adds `Tailscale-User-Login` and forwards to the direct listener.

  ```sh
  bun packages/bridge/scripts/stand-in-edge.ts --serve 9450 --to 8790 --owner smoke@example.com
  ```

  Confirm it prints `Stand-in edge listening on 127.0.0.1:9450`.

  **Needs your separate go-ahead:** stop the secure edge with Ctrl+C. Background and foreground the
  simulator app to reconnect. Confirm the simulator stays connected over the direct route. Restart
  the secure edge, stop the direct stand-in edge, and background and foreground the app again. Confirm
  the secure route reconnects.
- [ ] **Needs your separate go-ahead:** refresh the advertised secure address without changing the
  bridge key. Stop the default edge,
  then start a second local forwarder on `9444`. The secure listener ignores its added Tailscale
  header; the channel still authenticates the bridge key.

  ```sh
  bun packages/bridge/scripts/stand-in-edge.ts --serve 9444 --to 8788 --owner smoke@example.com
  ```

  Update the address. Create only the browser link first.

  ```sh
  admin secure url http://127.0.0.1:9444
  ```

  ```sh
  admin pair --name "Refresh browser address"
  ```

  Open it in a fresh tab at `http://localhost:8081/#pair=...` and finish the known-key address
  update before generating the simulator link. Confirm the app briefly shows `Updated the address for
  <Mac>.`. The bridge keeps one pairing code at a time, and each `admin pair` replaces the previous
  code.

  ```sh
  admin pair --watch --name "Refresh simulator address"
  ```

  Paste the simulator link into Pair and finish its known-key address update. A known-key link must
  not redeem its code. Confirm the direct route and token remain stored for both devices, and that
  `admin devices` still lists the same two devices with no additional device.

  ```sh
  admin devices
  ```

- [ ] **Needs your separate go-ahead:** confirm that the direct stand-in edge is stopped so neither
  device has a working direct route. Rotate the scratch bridge identity.

  ```sh
  admin identity rotate
  ```

  **Needs your separate go-ahead:** confirm each secure session closes, the app shows the
  identity-changed message and `Pair again`, and reconnect does not accept the old pinned key. Create
  a browser link, open it in a fresh tab, and finish pairing it before generating the simulator link.
  The bridge keeps one pairing code at a time, and each `admin pair` replaces the previous code.
  The new key should work after pairing.

  ```sh
  admin pair --name "Re-pair browser"
  ```

  Open the browser link in a fresh tab and finish pairing it with the new key.

  **Needs your separate go-ahead:** create the simulator link and finish pairing it in Pair. The
  browser must have finished re-pairing before you run this command.

  ```sh
  admin pair --watch --name "Re-pair simulator"
  ```

Use only this scratch bridge and its scratch state for every check. Never point it at the user's
normal `herdr-core` session.

## Cleanup

- [ ] Stop only the Expo server, stand-in edges and bridge started for this checklist, using Ctrl+C
  in their terminals. If the scratch core is still running, use only the wrapper and the recorded
  scratch root and session. This follows [prototype.md's kept-core procedure](prototype.md#stopping-a-kept-scratch-core-by-hand).

  ```sh
  root=/tmp/herdr-smoke-XXXXXX
  session=herdr-smoke-REPLACE_WITH_RECORDED_SESSION
  scratch() { HC_SESSION="$session" "$root/hc-scratch"; }
  echo '{"jsonrpc":"2.0","id":1,"method":"terminal.list","params":{"all":true}}' | scratch
  ```

- [ ] Check the reply and confirm every terminal belongs to this smoke run. If any terminal is unfamiliar or you cannot confirm ownership, leave the scratch root in place and do not stop the core. Otherwise, send `server.stop` through the same wrapper and wait for the shutdown acknowledgment and wrapper exit. If shutdown is not confirmed, keep the scratch root.

  ```sh
  echo '{"jsonrpc":"2.0","id":2,"method":"server.stop","params":{}}' | scratch
  ```

- [ ] After the shutdown acknowledgment and wrapper exit, remove only this scratch root.

  ```sh
  rm -rf "$root"
  ```

  Never send a core shutdown or update command outside this scratch wrapper, and never kill a core process.

## Known open items

- U7 review finding, tracked in PR #22: a recognized question can absorb the previous menu's last choice row. Check prompt transitions and record whether the choice list contains only the current question.
- The shared `Text` component has no idle-title variant or alignment option. Some pair screens use fixed inline text sizes because no variant exists.
- U6 `Banner` has no action slot.
- Space and tab creation controls stay enabled while the app is offline or unauthorized.
- Push notifications are not implemented. U15 waits for push credentials. Notification settings only save preferences.
