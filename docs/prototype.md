# The hc prototype

`bun run prototype:hc` is one checked run of the bridge's client stack against a scratch herdr-core. It is the only entry point. The code is in `packages/bridge/src/prototype/`, and `packages/bridge/scripts/prototype-hc.ts` wires it to the real clock, processes and filesystem.

## What it does

1. Makes a scratch root, `/tmp/hmp-XXXXXX`, with its own `home`, `run`, `state`, `config` and `cwd` directories, and a fresh session name, `hmp-` plus 8 hex digits.
2. Starts `hc connect` with only these variables: `PATH` and the locale from the caller, then `HC_SESSION`, `HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` pointing into the scratch root. `hc connect` starts the scratch core. Every spawn is checked first, and refused if `HC_SOCKET`, `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SCOPE` or `HC_RUNTIME` is set, if a directory is outside the scratch root, or if any other variable is present.
3. Says `hello` with generation 1 and `framed: true`, and requires hc 0.1.17, the version the schema is pinned to.
4. Runs a fixture with `terminal.run`: `/bin/sh` in the scratch `cwd`, with no parent, `wait: false`, `keep: false` and the label `herdr-mobile.prototype` set to the session name. The fixture prints `paint-<session>`, waits for the gate file, reports `working` through OSC 7501, prints `live-<session>`, and reports `done`.
5. Subscribes with exactly `{"terminal": <fixture>, "labels": {"herdr-mobile.prototype": <session>}}` and checks that the snapshot holds the fixture and nothing else.
6. Attaches with `observe: true`, renders every DATA payload into `@xterm/headless`, and returns CREDIT only once a write is on the screen. It never sends keys or RESIZE.
7. Waits for the first paint on screen, opens the gate, then waits for the live marker and both statuses.
8. Prints the hello, the filter, the snapshot, the statuses and the screen, then cleans up.

## Deadlines

| Stage   | Limit         | Covers                                                       |
| ------- | ------------- | ------------------------------------------------------------ |
| connect | 10 s          | Starting `hc connect` and the hello reply                    |
| setup   | 10 s          | `terminal.run`, `events.subscribe` and `terminal.attach`     |
| render  | 10 s          | The first paint rendered                                     |
| marker  | 10 s          | The live marker on screen, and the working and done statuses |
| run     | 30 s          | All of the above together                                    |
| cleanup | 10 s, its own | Everything after the run, however the run ended              |

A missed limit fails the run with `prototype deadline exceeded: <stage>`, or `prototype deadline exceeded: workflow` when the 30 s run limit comes first. A missed marker also says what never arrived, such as `prototype screen missing live-output marker`.

## Interruption

The first SIGINT or SIGTERM stops the run: every wait rejects with `prototype cancelled: SIGINT`, and late renderer and event callbacks do nothing, so they send no CREDIT and print nothing. Cleanup then runs with a fresh token. A signal during cleanup only prints `cleanup is running and ends by its own deadline`: it doesn't restart cleanup or move its deadline.

## Cleanup

Cleanup runs once:

1. It uses the run's connection if that still takes calls. Otherwise it starts one more scratch-only `hc connect`, checked the same way, and sends plain JSON-RPC on it, which needs no hello.
2. It lists every terminal, finished ones included, and refuses `server.stop` if any lacks the run's label: `refusing server.stop: the core runs N terminal(s) this run didn't start`.
3. It calls `server.stop` and waits for its own `hc connect` children to exit. It never looks for or signals any other process.
4. Only when the stop was acknowledged and every child exited does it remove the scratch root and print `cleanup: scratch shutdown confirmed; removed /tmp/hmp-XXXXXX`.

Otherwise the run fails with `scratch shutdown unconfirmed; retained scratch state`, after `scratch shutdown was not acknowledged` when the stop never came. It prints `cleanup: kept /tmp/hmp-XXXXXX` and leaves the root in place, because the scratch core may still be running there.

### Stopping a kept scratch core by hand

Never point these at anything but the kept root. First set the scratch environment and list the terminals:

```sh
root=/tmp/hmp-XXXXXX
session=$(ls "$root/run/herdr-core" | grep -E '^hmp-[0-9a-f]+\.sock$' | sed 's/\.sock$//')
scratch() {
  env -i PATH="$PATH" HC_SESSION="$session" HOME="$root/home" XDG_RUNTIME_DIR="$root/run" \
    XDG_STATE_HOME="$root/state" XDG_CONFIG_HOME="$root/config" hc connect
}
echo '{"jsonrpc":"2.0","id":1,"method":"terminal.list","params":{"all":true}}' | scratch
```

Check that every terminal in the reply has `"herdr-mobile.prototype": "<session>"` in its labels. Then stop it and remove the root:

```sh
echo '{"jsonrpc":"2.0","id":2,"method":"server.stop","params":{}}' | scratch
rm -rf "$root"
```

## Tests

`packages/bridge/src/prototype/workflow.test.ts` runs the same workflow against fakes: a controlled clock, a recording filesystem, `hc connect` children backed by hc-client's `FakeCore`, and a renderer whose callbacks can be held. It covers the scratch environment, every deadline, interruption during startup and during cleanup, late callbacks, and a shutdown that never confirms. `bun test` never needs an installed `hc`.

## Results

On 2026-11-02, `bun run prototype:hc` passed against hc 0.1.16 on macOS: generation 1 in framed mode, the filtered snapshot, an observe-only attachment with both markers rendered, `working` then `done`, and a confirmed scratch shutdown with the root removed.
