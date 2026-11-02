# herdr-core reference files

Unchanged copies of the herdr-core files that `packages/hc-client` follows, at their original paths. They come from [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core) at commit `7a54c2975225a859b7e7d67302df5efc249fb9d0`, taken 2026-11-01. herdr-core is licensed under Apache-2.0; see `LICENSE` in this folder.

They are here because herdr-core is younger than unshit's 180-day bar for reference repositories, and unshit reads files in the local project.

| File | What it is |
| --- | --- |
| `schema/README.md` | The protocol outside OpenRPC: plain and framed connections, attach streams, events, documents and status |
| `crates/herdr-core/src/wire.rs` | The framed-mode codec, `[channel u32 LE][kind u8][len u32 LE][payload]` |
| `crates/herdr-core/src/attach.rs` | `hc attach`, the client side of an attach stream: raw bytes both ways and the detach chord |
| `crates/herdr-core/src/viewers.rs` | The core side of attach streams: first paint, live bytes, input and which viewer sets the size |
| `crates/herdr-core/src/events.rs` | Event delivery in order, and `missed` with a fresh snapshot for a subscriber that falls behind |
| `crates/herdr-core/src/rpc.rs` | JSON-RPC 2.0 envelopes, errors with stable kinds, and the method table |
| `crates/herdr-core/tests/common/framed.rs` | herdr-core's framed-mode test client, with a viewer that renders what it receives |
| `crates/herdr-core/tests/common/mod.rs` | Its test harness, including an isolated core with its own `HC_SESSION` and XDG directories |

The core installed on 2026-11-01 was 0.1.16. To refresh, take the same files at the commit that matches the core you target and update the commit above.
