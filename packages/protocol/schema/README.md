# Pinned herdr-core API

`hc.openrpc.json` is herdr-core's API at version 0.1.17, protocol generation 1, 32 methods.

It is the output of `hc schema` from herdr-core 0.1.17 installed on this Mac, taken 2026-11-12 and formatted with two-space indentation. Compared with 0.1.16, it keeps all 32 methods and adds support for feature negotiation and resize notifications.

To update from an installed core:

```sh
hc schema | bun -e 'console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()), null, 2))' > packages/protocol/schema/hc.openrpc.json
bun test
```

`hc schema` prints one line; the formatting keeps diffs readable. The test fails if a method in `REQUIRED_HC_METHODS` is gone or the protocol generation changed.
