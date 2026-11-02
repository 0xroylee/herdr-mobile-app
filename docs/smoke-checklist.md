# First-run smoke checklist

No simulator, physical device or browser run has been completed for this build. Use this checklist for the first run. Record failures with the platform, OS version and screen where they occur.

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
  chmod 700 "$root/hc-scratch"
  printf 'Smoke root: %s\nSession: %s\n' "$root" "$session"
  ```

- [ ] Build the web app with `bun run build:web`. Confirm that `packages/app/dist/index.html` exists.
- [ ] Start the bridge with the wrapper as its `hc` executable. Set the bridge's state directory to the same scratch root so its `devices.json` and `admin.sock` are isolated too. The explicit `--session` is required because the bridge does not inherit the shell's `HC_SESSION`.

  ```sh
  XDG_STATE_HOME="$root/state" bun run bridge serve \
    --owner you@example.com \
    --port 8787 \
    --web packages/app/dist \
    --hc "$root/hc-scratch" \
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
- [ ] Pinch the terminal text in and out. Confirm that the size stays between 8 and 16 points. Double-tap to reset the size, then scroll the terminal and confirm that scrolling does not change zoom.
- [ ] Confirm Take over. Check that the app reattaches with input enabled and resizes the Mac terminal to the grid that fits the pane at the current zoom. Confirm that the pane keeps its zoom, double-tap still resets it, and the terminal remains visible. Cancel the confirmation once and confirm that watch mode remains active.
- [ ] Pending until a safe fixture with adjacent wrapped tabs is available: tap near both edges of neighboring tab pills and in the gap between them. Confirm each tap selects only the tab intended by its hit area, with no clipping or overlap. Do not create tabs in the user's Herdr window.
- [ ] Pending until an isolated `herdr-app` target is verified: create a space and tab and confirm that they appear in document order. Do not run this check against the user's Herdr window. The controls currently remain enabled while offline or unauthorized.
- [ ] Change theme and notification preferences, restart the app, and confirm that the choices persist. Confirm that notification switches do not send push alerts.

## Physical device

Repeat on at least one iOS or Android device. Check device-specific items that the simulator cannot cover.

- [ ] Connect the phone and Mac to the same tailnet. Open the bridge's HTTPS address. Confirm that the app reaches the paired bridge and shows the device name and connection state.
- [ ] Scan the pairing QR code. Test both camera permission paths. Confirm that the preview appears after permission, the code is accepted once, and a denied permission still allows manual URL and code entry.
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

## Cleanup

- [ ] Stop the bridge with Ctrl+C in its terminal. If the scratch core is still running, use only the wrapper and the recorded scratch root and session. This follows [prototype.md's kept-core procedure](prototype.md#stopping-a-kept-scratch-core-by-hand).

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
