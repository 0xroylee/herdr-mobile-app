// herdr-core client: JSON-RPC lines, framed mode, attach streams and events.
// The bridge runs it over `hc connect` and the app over the bridge's WebSocket, so it takes a
// transport from the caller and never imports Node built-ins.

export {
  decodeClose,
  decodeCredit,
  decodeFacts,
  decodeFocus,
  decodeResize,
  encodeClose,
  encodeCredit,
  encodeFacts,
  encodeFocus,
  encodeFrame,
  encodeResize,
  FrameDecoder,
  type FrameDecoderOptions,
  FrameError,
  type PayloadAllocator,
} from "./frame.ts";
export { utf8Decode, utf8Encode } from "./utf8.ts";
