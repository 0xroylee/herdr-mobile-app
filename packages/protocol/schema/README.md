# Pinned herdr-core API

`hc.openrpc.json` is herdr-core's API at version 0.1.16, protocol generation 1, 32 methods.

It is the output of `hc schema` from the core that herdr-app 0.1.10 installed, taken 2026-11-01 and formatted with two-space indentation. Apart from the version string it matches 0.1.15, which was `schema/released.openrpc.json` in [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core) at commit `4a3591aa835c197f57a5d1b8e8951a75e2a79faa`. herdr-core's API only adds things, and its tests fail on any change that would break a client of the released file.

To update from an installed core:

```sh
hc schema | bun -e 'console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()), null, 2))' > packages/protocol/schema/hc.openrpc.json
bun test
```

`hc schema` prints one line; the formatting keeps diffs readable. The test fails if a method in `REQUIRED_HC_METHODS` is gone or the protocol generation changed.
