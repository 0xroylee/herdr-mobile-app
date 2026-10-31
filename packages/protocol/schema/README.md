# Pinned herdr-core API

`hc.openrpc.json` is herdr-core's released API: version 0.1.15, protocol generation 1, 32 methods.

It is `schema/released.openrpc.json` from [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core) at commit `4a3591aa835c197f57a5d1b8e8951a75e2a79faa`, fetched 2026-10-31. herdr-core's API only adds things, and its tests fail on any change that would break a client of the released file.

To update from an installed core:

```sh
hc schema > packages/protocol/schema/hc.openrpc.json
npm test
```

The test fails if a method in `REQUIRED_HC_METHODS` is gone or the protocol generation changed.
