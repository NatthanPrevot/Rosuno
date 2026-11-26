// Website and appearance studio: image inspection for the image library
// (DEV-001; studio specification section 5.1).
//
// Pure and dependency-free. An upload is accepted only as a PNG, JPEG or WebP
// image recognized by its own signature (never by a file name or a declared
// type; SVG, GIF, HTML and everything else are unsupported), walked structure
// by structure within its bounds, at most 900,000 bytes and 16 to 4096 pixels
// each way, and still. Its metadata is removed before anything is stored (the
// digest the database records is that of the stripped bytes):
// - PNG: the signature, IHDR first, every chunk within bounds with a valid
//   CRC, ending at IEND (anything after it is dropped). Kept: IHDR, PLTE,
//   IDAT, IEND, tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, pHYs. Dropped: tEXt, zTXt,
//   iTXt, eXIf, tIME and every other ancillary chunk. Refused: an animation
//   chunk (acTL, fcTL, fdAT: APNG) and an unknown critical chunk.
// - JPEG: SOI, then every marker segment within bounds up to SOS; the size
//   from a baseline, extended or progressive frame (SOF0, SOF1, SOF2; every
//   other frame type is unsupported). Kept: APP0, APP2 holding an ICC profile,
//   DQT, DHT, DAC, DRI and the frame. Dropped: APP1 (EXIF, XMP), every other
//   APPn and COM. The scan data is copied verbatim and must end with EOI.
// - WebP: RIFF whose length is the file's less 8, WEBP, every chunk within
//   bounds. Kept: VP8X, VP8, VP8L, ALPH, ICCP. Dropped: EXIF, XMP and unknown
//   chunks (the VP8X flags and the RIFF length are rewritten). Refused: ANIM,
//   ANMF or the VP8X animation flag. The size comes from the VP8 frame header
//   or the VP8L header and must equal the VP8X canvas when there is one.

import type { AssetFormat } from "./appearance-schema.ts";

export const MAX_ASSET_BYTES = 900_000;
export const MIN_ASSET_DIMENSION = 16;
export const MAX_ASSET_DIMENSION = 4096;
export const ASSET_MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const);
export type AssetMediaType = (typeof ASSET_MEDIA_TYPES)[AssetFormat];

export const IMAGE_PROBLEMS = Object.freeze([
  "unsupported",
  "invalid",
  "too_large",
  "dimensions",
  "animated",
] as const);
export type ImageProblem = (typeof IMAGE_PROBLEMS)[number];

export type InspectedImage = {
  readonly status: "ok";
  readonly mediaType: AssetMediaType;
  readonly format: AssetFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
};
export type ImageInspection =
  InspectedImage | { readonly status: ImageProblem };

const problem = (status: ImageProblem) => Object.freeze({ status });
const UNSUPPORTED = problem("unsupported");
const INVALID = problem("invalid");
const TOO_LARGE = problem("too_large");
const DIMENSIONS = problem("dimensions");
const ANIMATED = problem("animated");

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number): number =>
  b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + ((b[at + 3] << 24) >>> 0);
const ascii = (b: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...b.subarray(at, at + length));
const startsWith = (
  b: Uint8Array,
  prefix: readonly number[],
  at = 0,
): boolean =>
  b.length >= at + prefix.length &&
  prefix.every((value, i) => b[at + i] === value);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// CRC-32 (ISO-HDLC, as PNG uses it) of bytes[start, end).
export function crc32(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Standard base64 with padding, no line breaks.
export function base64Of(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}

const BASE64_TEXT =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_VALUES = (() => {
  const values = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i += 1) {
    values[BASE64.charCodeAt(i)] = i;
  }
  values["=".charCodeAt(0)] = 0;
  return values;
})();

// The bytes of strict, padded, unwrapped base64; null for anything else
// (whitespace, URL-safe characters, non-zero padding bits).
export function bytesOfBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !BASE64_TEXT.test(text)) {
    return null;
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  const value = (i: number): number => BASE64_VALUES[text.charCodeAt(i)];
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (value(i) << 18) |
      (value(i + 1) << 12) |
      (value(i + 2) << 6) |
      value(i + 3);
    for (const shift of [16, 8, 0]) {
      if (at < out.length) {
        out[at] = (n >> shift) & 255;
        at += 1;
      }
    }
  }
  return base64Of(out) === text ? out : null;
}

function accepted(
  format: AssetFormat,
  width: number,
  height: number,
  bytes: Uint8Array,
): ImageInspection {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_ASSET_DIMENSION ||
    height < MIN_ASSET_DIMENSION ||
    width > MAX_ASSET_DIMENSION ||
    height > MAX_ASSET_DIMENSION
  ) {
    return DIMENSIONS;
  }
  return Object.freeze({
    status: "ok",
    mediaType: ASSET_MEDIA_TYPES[format],
    format,
    width,
    height,
    bytes,
  });
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Object.freeze([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_KEPT = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "pHYs",
]);
const PNG_ANIMATION = new Set(["acTL", "fcTL", "fdAT"]);
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function inspectPng(b: Uint8Array): ImageInspection {
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let idat = false;
  let plte = false;
  let ended = false;
  while (at < b.length) {
    if (at + 12 > b.length) {
      return INVALID;
    }
    const length = u32be(b, at);
    if (length > b.length - at - 12) {
      return INVALID;
    }
    const type = ascii(b, at + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return INVALID;
    }
    const end = at + 8 + length;
    if (crc32(b, at + 4, end) !== u32be(b, end)) {
      return INVALID;
    }
    if ((at === 8) !== (type === "IHDR")) {
      return INVALID;
    }
    if (PNG_ANIMATION.has(type)) {
      return ANIMATED;
    }
    if (type === "IHDR") {
      const data = at + 8;
      width = u32be(b, data);
      height = u32be(b, data + 4);
      colorType = b[data + 9];
      if (
        length !== 13 ||
        !(PNG_DEPTHS[colorType] ?? []).includes(b[data + 8]) ||
        b[data + 10] !== 0 ||
        b[data + 11] !== 0 ||
        b[data + 12] > 1
      ) {
        return INVALID;
      }
    } else if (type === "IDAT") {
      idat = true;
    } else if (type === "PLTE") {
      plte = true;
    }
    if (PNG_KEPT.has(type)) {
      kept.push(b.subarray(at, end + 4));
    } else if ((b[at + 4] & 0x20) === 0) {
      // An unknown critical chunk (upper-case first letter).
      return INVALID;
    }
    at = end + 4;
    if (type === "IEND") {
      if (length !== 0) {
        return INVALID;
      }
      ended = true;
      break;
    }
  }
  if (!ended || !idat || (colorType === 3 && !plte)) {
    return INVALID;
  }
  return accepted("png", width, height, concat(kept));
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const ICC_PROFILE = Object.freeze([
  0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
]);

function inspectJpeg(b: Uint8Array): ImageInspection {
  const kept: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let at = 2;
  let width = 0;
  let height = 0;
  let frame = false;
  for (;;) {
    if (at >= b.length || b[at] !== 0xff) {
      return INVALID;
    }
    while (at < b.length && b[at] === 0xff) {
      at += 1;
    }
    if (at + 3 > b.length) {
      return INVALID;
    }
    const marker = b[at];
    at += 1;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9)
    ) {
      return INVALID;
    }
    const length = u16be(b, at);
    if (length < 2 || at + length > b.length) {
      return INVALID;
    }
    const segment = concat([
      Uint8Array.of(0xff, marker),
      b.subarray(at, at + length),
    ]);
    if (marker === 0xda) {
      if (!frame || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
        return INVALID;
      }
      kept.push(Uint8Array.of(0xff, 0xda), b.subarray(at));
      return accepted("jpeg", width, height, concat(kept));
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const components = b[at + 7];
      if (frame || length < 8 || length !== 8 + 3 * components) {
        return INVALID;
      }
      height = u16be(b, at + 3);
      width = u16be(b, at + 5);
      if (height === 0) {
        return INVALID;
      }
      frame = true;
      kept.push(segment);
    } else if (
      marker >= 0xc3 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return UNSUPPORTED;
    } else if (
      marker === 0xc4 ||
      marker === 0xcc ||
      marker === 0xdb ||
      marker === 0xdd ||
      marker === 0xe0
    ) {
      kept.push(segment);
    } else if (marker === 0xe2) {
      if (startsWith(b, ICC_PROFILE, at + 2)) {
        kept.push(segment);
      }
    } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      // Dropped: EXIF, XMP and other application data, comments.
    } else {
      return INVALID;
    }
    at += length;
  }
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_FLAG_ICC = 0x20;
const WEBP_FLAG_EXIF = 0x08;
const WEBP_FLAG_XMP = 0x04;
const WEBP_FLAG_ANIMATION = 0x02;

function inspectWebp(b: Uint8Array): ImageInspection {
  if (b.length < 20 || u32le(b, 4) !== b.length - 8) {
    return INVALID;
  }
  const chunks: Uint8Array[] = [];
  let at = 12;
  let canvas: { readonly width: number; readonly height: number } | null = null;
  let vp8xIndex = -1;
  let image: { readonly width: number; readonly height: number } | null = null;
  let icc = false;
  let alpha = false;
  while (at < b.length) {
    if (at + 8 > b.length) {
      return INVALID;
    }
    const fourcc = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const padded = size + (size & 1);
    if (padded > b.length - at - 8) {
      return INVALID;
    }
    const data = at + 8;
    const chunk = b.subarray(at, data + padded);
    switch (fourcc) {
      case "VP8X": {
        if (at !== 12 || size !== 10) {
          return INVALID;
        }
        if ((b[data] & WEBP_FLAG_ANIMATION) !== 0) {
          return ANIMATED;
        }
        canvas = {
          width: 1 + u24le(b, data + 4),
          height: 1 + u24le(b, data + 7),
        };
        vp8xIndex = chunks.length;
        chunks.push(Uint8Array.from(chunk));
        break;
      }
      case "ANIM":
      case "ANMF":
        return ANIMATED;
      case "VP8 ": {
        if (
          image !== null ||
          size < 10 ||
          (b[data] & 1) !== 0 ||
          !startsWith(b, [0x9d, 0x01, 0x2a], data + 3)
        ) {
          return INVALID;
        }
        image = {
          width: u16le(b, data + 6) & 0x3fff,
          height: u16le(b, data + 8) & 0x3fff,
        };
        chunks.push(chunk);
        break;
      }
      case "VP8L": {
        if (image !== null || size < 5 || b[data] !== 0x2f) {
          return INVALID;
        }
        const bits = u32le(b, data + 1);
        if (bits >>> 29 !== 0) {
          return INVALID;
        }
        image = {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
        };
        chunks.push(chunk);
        break;
      }
      case "ALPH":
        alpha = true;
        chunks.push(chunk);
        break;
      case "ICCP":
        icc = true;
        chunks.push(chunk);
        break;
      default:
        // Dropped: EXIF, XMP and unknown chunks.
        break;
    }
    at = data + padded;
  }
  if (image === null) {
    return INVALID;
  }
  if (canvas === null) {
    if (alpha || icc) {
      return INVALID;
    }
  } else {
    if (canvas.width !== image.width || canvas.height !== image.height) {
      return INVALID;
    }
    const vp8x = chunks[vp8xIndex];
    vp8x[8] =
      (vp8x[8] & ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP | WEBP_FLAG_ICC)) |
      (icc ? WEBP_FLAG_ICC : 0);
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  const riff = body.length + 4;
  header.set(
    [riff & 255, (riff >>> 8) & 255, (riff >>> 16) & 255, (riff >>> 24) & 255],
    4,
  );
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return accepted("webp", image.width, image.height, concat([header, body]));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// The image's format, size and stripped bytes, or why it is refused.
export function inspectImage(bytes: unknown): ImageInspection {
  if (!(bytes instanceof Uint8Array)) {
    return INVALID;
  }
  if (bytes.length > MAX_ASSET_BYTES) {
    return TOO_LARGE;
  }
  try {
    if (startsWith(bytes, PNG_SIGNATURE)) {
      return inspectPng(bytes);
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
      return inspectJpeg(bytes);
    }
    if (
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    ) {
      return inspectWebp(bytes);
    }
    return UNSUPPORTED;
  } catch {
    return INVALID;
  }
}
