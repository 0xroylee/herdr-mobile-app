// UTF-8 without TextEncoder or TextDecoder, which Hermes may not provide. Both follow
// the WHATWG encoding standard: lone surrogates encode as U+FFFD, and each maximal
// invalid byte sequence decodes as one U+FFFD.

const REPLACEMENT = 0xfffd;
const CHUNK = 8192;

export function utf8Encode(text: string): Uint8Array {
  // A UTF-16 code unit never needs more than three bytes; a surrogate pair needs four for two.
  const out = new Uint8Array(text.length * 3);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = REPLACEMENT;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = REPLACEMENT;
    }
    if (code < 0x80) {
      out[at++] = code;
    } else if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[at++] = 0xe0 | (code >> 12);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    } else {
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 0x3f);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    }
  }
  return out.slice(0, at);
}

export function utf8Decode(bytes: Uint8Array): string {
  const units: number[] = [];
  let text = "";
  const emit = (code: number) => {
    if (code > 0xffff) {
      const offset = code - 0x10000;
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      units.push(code);
    }
    if (units.length >= CHUNK) {
      text += String.fromCharCode(...units);
      units.length = 0;
    }
  };

  let needed = 0;
  let seen = 0;
  let code = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (needed === 0) {
      if (byte <= 0x7f) {
        emit(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        code = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2;
        code = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        code = byte & 0x07;
      } else {
        emit(REPLACEMENT);
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      // The sequence ended early: replace it and read this byte again as a fresh start.
      needed = 0;
      seen = 0;
      code = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(REPLACEMENT);
      i--;
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    code = (code << 6) | (byte & 0x3f);
    seen++;
    if (seen === needed) {
      emit(code);
      needed = 0;
      seen = 0;
      code = 0;
    }
  }
  if (needed !== 0) emit(REPLACEMENT);
  return text + String.fromCharCode(...units);
}
