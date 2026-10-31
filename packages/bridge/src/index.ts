// herdr-bridge runs on the agent machine. It listens on 127.0.0.1 behind `tailscale serve`,
// checks the Tailscale identity header and the device token, and passes each phone session
// through to its own `hc connect`. See "Proposed architecture" in docs/research.md.
export {};
