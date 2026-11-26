// DEV-001 website and appearance studio: image inspection (studio
// specification section 5.1).
//
// Every image here is a synthetic 16x16 byte string built by
// tests/site-appearance-fixtures.mjs. These tests prove that only PNG, JPEG
// and WebP images recognized by their own structure are accepted, that their
// metadata is removed before anything is stored (the digest is that of the
// stripped bytes), and that SVG, GIF, HTML, polyglots, animations, damaged
// files and out-of-bounds sizes are refused. The database checks signature,
// size, dimensions and digest again (proved by
// apps/web/tests/dev-001-site-appearance-db-proof.mjs).

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import zlib from "node:zlib";

import {
  base64Of,
  bytesOfBase64,
  crc32,
  inspectImage,
  MAX_ASSET_BYTES,
} from "../src/application/appearance-image.ts";
import {
  cleanJpeg,
  cleanPng,
  cleanWebp,
  DHT,
  DQT,
  EOI,
  GIF,
  HTML,
  idat,
  IEND,
  ihdr,
  JFIF,
  jpeg,
  jpegSegment,
  png,
  pngChunk,
  SCAN,
  SOI,
  sof,
  SVG,
  vp8,
  vp8l,
  vp8x,
  webp,
  webpChunk,
} from "./site-appearance-fixtures.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const u8 = (buffer) => new Uint8Array(buffer);
const statusOf = (bytes) => inspectImage(u8(bytes)).status;

function accepted(bytes, format, width = 16, height = 16) {
  const result = inspectImage(u8(bytes));
  assert.equal(result.status, "ok", result.status);
  assert.equal(result.format, format);
  assert.equal(
    result.mediaType,
    { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[format],
  );
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.ok(Object.isFrozen(result));
  return Buffer.from(result.bytes);
}

test("IMG-1 PNG: a clean image is accepted as it is; text, EXIF, time and unknown ancillary chunks are removed (the digest is that of the clean image); anything after IEND is dropped", () => {
  const clean = cleanPng();
  assert.deepEqual(accepted(clean, "png"), clean);
  const dirty = png(
    ihdr(),
    pngChunk("tEXt", Buffer.from("Author\u0000Synthetic", "latin1")),
    pngChunk("eXIf", Buffer.from("MM\u0000*GPS", "latin1")),
    pngChunk("zTXt", Buffer.from("k\u0000\u0000x", "latin1")),
    pngChunk(
      "iTXt",
      Buffer.from(
        "XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000<x/>",
        "latin1",
      ),
    ),
    pngChunk("tIME", Buffer.from([7, 234, 11, 26, 12, 0, 0])),
    pngChunk("prVt", Buffer.from("private")),
    idat(),
    IEND,
    Buffer.from("<script>trailing</script>"),
  );
  const stripped = accepted(dirty, "png");
  assert.deepEqual(stripped, clean);
  assert.equal(sha256(stripped), sha256(clean));
  assert.notEqual(sha256(dirty), sha256(clean));
  // Kept ancillary chunks stay, in order.
  const kept = png(
    ihdr(),
    pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
    pngChunk("sRGB", Buffer.from([0])),
    pngChunk("pHYs", Buffer.alloc(9)),
    idat(),
    IEND,
  );
  assert.deepEqual(accepted(kept, "png"), kept);
  // A palette image needs its PLTE.
  const palette = png(
    ihdr(16, 16, 3, 8),
    pngChunk("PLTE", Buffer.alloc(3)),
    idat(),
    IEND,
  );
  assert.deepEqual(accepted(palette, "png"), palette);
  assert.equal(statusOf(png(ihdr(16, 16, 3, 8), idat(), IEND)), "invalid");
});

test("IMG-2 PNG refusals: APNG animation chunks (animated), an unknown critical chunk, a bad CRC, IHDR not first or malformed, no IDAT or IEND, truncation (invalid), and sizes outside 16 to 4096 pixels (dimensions)", () => {
  assert.equal(
    statusOf(png(ihdr(), pngChunk("acTL", Buffer.alloc(8)), idat(), IEND)),
    "animated",
  );
  assert.equal(
    statusOf(png(ihdr(), idat(), pngChunk("fcTL", Buffer.alloc(26)), IEND)),
    "animated",
  );
  assert.equal(
    statusOf(png(ihdr(), pngChunk("ABCD", Buffer.alloc(4)), idat(), IEND)),
    "invalid",
  );
  assert.equal(
    statusOf(
      png(ihdr(), pngChunk("IDAT", Buffer.alloc(4), { badCrc: true }), IEND),
    ),
    "invalid",
  );
  assert.equal(statusOf(png(idat(), ihdr(), IEND)), "invalid");
  assert.equal(statusOf(png(ihdr(16, 16, 2, 4), idat(), IEND)), "invalid");
  assert.equal(statusOf(png(ihdr(16, 16, 7, 8), idat(), IEND)), "invalid");
  assert.equal(statusOf(png(ihdr(), IEND)), "invalid");
  assert.equal(statusOf(png(ihdr(), idat())), "invalid");
  assert.equal(statusOf(png(ihdr(), ihdr(), idat(), IEND)), "invalid");
  const clean = cleanPng();
  assert.equal(statusOf(clean.subarray(0, clean.length - 6)), "invalid");
  assert.equal(statusOf(clean.subarray(0, 20)), "invalid");
  const huge = Buffer.from(clean);
  huge.writeUInt32BE(0xfffffff0, 8);
  assert.equal(statusOf(huge), "invalid");
  assert.equal(statusOf(cleanPng(15, 16)), "dimensions");
  assert.equal(statusOf(cleanPng(16, 4097)), "dimensions");
  assert.equal(accepted(cleanPng(4096, 16), "png", 4096, 16).length > 0, true);
});

test("IMG-3 JPEG: a baseline or progressive image is accepted; APP1 (EXIF, XMP), other APPn and comments are removed, APP0 and an APP2 ICC profile are kept, the scan is copied verbatim", () => {
  const clean = cleanJpeg();
  assert.deepEqual(accepted(clean, "jpeg"), clean);
  const exif = jpegSegment(
    0xe1,
    Buffer.from("Exif\u0000\u0000MM\u0000*GPS-synthetic", "latin1"),
  );
  const xmp = jpegSegment(
    0xe1,
    Buffer.from("http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta/>", "latin1"),
  );
  const comment = jpegSegment(0xfe, Buffer.from("synthetic comment"));
  const app13 = jpegSegment(0xed, Buffer.from("Photoshop 3.0\u0000", "latin1"));
  const mpf = jpegSegment(0xe2, Buffer.from("MPF\u0000data", "latin1"));
  const icc = jpegSegment(
    0xe2,
    Buffer.from("ICC_PROFILE\u0000\u0001\u0001profile", "latin1"),
  );
  const dirty = jpeg(
    JFIF,
    exif,
    xmp,
    comment,
    app13,
    mpf,
    icc,
    DQT,
    sof(0xc0),
    DHT,
  );
  const stripped = accepted(dirty, "jpeg");
  assert.deepEqual(stripped, jpeg(JFIF, icc, DQT, sof(0xc0), DHT));
  assert.ok(!stripped.includes(Buffer.from("GPS-synthetic")));
  assert.ok(!stripped.includes(Buffer.from("xmpmeta")));
  // Fill bytes before a marker are allowed and normalized.
  const filled = Buffer.concat([
    SOI,
    Buffer.from([0xff, 0xff]),
    JFIF.subarray(1),
    DQT,
    sof(0xc0),
    DHT,
    SCAN,
    EOI,
  ]);
  assert.deepEqual(accepted(filled, "jpeg"), clean);
  assert.deepEqual(
    accepted(jpeg(JFIF, DQT, sof(0xc2, 32, 24), DHT), "jpeg", 32, 24).length >
      0,
    true,
  );
  assert.deepEqual(
    accepted(jpeg(JFIF, DQT, sof(0xc1), DHT), "jpeg").length > 0,
    true,
  );
});

test("IMG-4 JPEG refusals: lossless, hierarchical and arithmetic frames (unsupported); no frame before the scan, two frames, a missing or trailing EOI, a bad segment length, a standalone marker before the scan, a zero height (invalid); sizes out of bounds (dimensions)", () => {
  for (const marker of [
    0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]) {
    assert.equal(
      statusOf(jpeg(JFIF, DQT, sof(marker), DHT)),
      "unsupported",
      marker.toString(16),
    );
  }
  assert.equal(statusOf(jpeg(JFIF, DQT, DHT)), "invalid");
  assert.equal(statusOf(jpeg(JFIF, DQT, sof(0xc0), sof(0xc0), DHT)), "invalid");
  const clean = cleanJpeg();
  assert.equal(statusOf(clean.subarray(0, clean.length - 2)), "invalid");
  assert.equal(
    statusOf(Buffer.concat([clean, Buffer.from("trailing")])),
    "invalid",
  );
  const badLength = Buffer.from(clean);
  badLength.writeUInt16BE(0xfff0, 4);
  assert.equal(statusOf(badLength), "invalid");
  assert.equal(
    statusOf(
      Buffer.concat([
        SOI,
        Buffer.from([0xff, 0xd0]),
        JFIF,
        DQT,
        sof(0xc0),
        DHT,
        SCAN,
        EOI,
      ]),
    ),
    "invalid",
  );
  assert.equal(statusOf(jpeg(JFIF, DQT, sof(0xc0, 16, 0), DHT)), "invalid");
  assert.equal(
    statusOf(Buffer.concat([SOI, Buffer.from([0x00, 0x01])])),
    "unsupported",
  );
  assert.equal(
    statusOf(
      Buffer.concat([
        SOI,
        Buffer.from([0xff, 0x01, 0, 0]),
        DQT,
        sof(0xc0),
        DHT,
        SCAN,
        EOI,
      ]),
    ),
    "invalid",
  );
  assert.equal(
    statusOf(
      Buffer.concat([
        SOI,
        Buffer.from([0xff, 0xc8, 0, 2]),
        DQT,
        sof(0xc0),
        DHT,
        SCAN,
        EOI,
      ]),
    ),
    "invalid",
  );
  assert.equal(statusOf(cleanJpeg(15, 16)), "dimensions");
  assert.equal(statusOf(cleanJpeg(4097, 16)), "dimensions");
});

test("IMG-5 WebP: lossless and lossy images are accepted with their header size; EXIF, XMP and unknown chunks are removed, the VP8X flags and the RIFF length rewritten; ICCP and ALPH are kept", () => {
  const lossless = cleanWebp();
  assert.deepEqual(accepted(lossless, "webp"), lossless);
  const lossy = webp(vp8(24, 20));
  assert.deepEqual(accepted(lossy, "webp", 24, 20), lossy);
  const exifFlag = 0x08;
  const xmpFlag = 0x04;
  const iccFlag = 0x20;
  const alphaFlag = 0x10;
  const dirty = webp(
    vp8x(exifFlag | xmpFlag | iccFlag | alphaFlag),
    webpChunk("ICCP", Buffer.from("profile")),
    webpChunk("ALPH", Buffer.from([0, 1, 2])),
    vp8l(),
    webpChunk("EXIF", Buffer.from("MM\u0000*GPS-synthetic", "latin1")),
    webpChunk("XMP ", Buffer.from("<x:xmpmeta/>")),
    webpChunk("ZZZZ", Buffer.from("unknown")),
  );
  const stripped = accepted(dirty, "webp");
  assert.deepEqual(
    stripped,
    webp(
      vp8x(iccFlag | alphaFlag),
      webpChunk("ICCP", Buffer.from("profile")),
      webpChunk("ALPH", Buffer.from([0, 1, 2])),
      vp8l(),
    ),
  );
  assert.equal(stripped.readUInt32LE(4), stripped.length - 8);
  assert.ok(!stripped.includes(Buffer.from("GPS-synthetic")));
  // The ICC flag follows the ICCP chunk.
  assert.deepEqual(
    accepted(webp(vp8x(iccFlag), vp8l()), "webp"),
    webp(vp8x(0), vp8l()),
  );
});

test("IMG-6 WebP refusals: ANIM, ANMF or the animation flag (animated); a RIFF length that is not the file's, no image chunk, two image chunks, a canvas that differs from the image, ALPH or ICCP without VP8X, a VP8X that is not first, a lossy interframe, a bad VP8L signature or version, truncation (invalid)", () => {
  assert.equal(statusOf(webp(vp8x(0x02), vp8l())), "animated");
  assert.equal(
    statusOf(webp(vp8x(0), webpChunk("ANIM", Buffer.alloc(6)), vp8l())),
    "animated",
  );
  assert.equal(
    statusOf(webp(vp8x(0), webpChunk("ANMF", Buffer.alloc(16)))),
    "animated",
  );
  const lossless = cleanWebp();
  const longer = Buffer.from(lossless);
  longer.writeUInt32LE(longer.length, 4);
  assert.equal(statusOf(longer), "invalid");
  assert.equal(statusOf(webp(webpChunk("EXIF", Buffer.alloc(4)))), "invalid");
  assert.equal(statusOf(webp(vp8l(), vp8l())), "invalid");
  assert.equal(statusOf(webp(vp8x(0, 32, 32), vp8l())), "invalid");
  assert.equal(
    statusOf(webp(webpChunk("ALPH", Buffer.alloc(2)), vp8l())),
    "invalid",
  );
  assert.equal(statusOf(webp(vp8l(), vp8x(0))), "invalid");
  const interframe = vp8();
  interframe[8] |= 1;
  assert.equal(statusOf(webp(interframe)), "invalid");
  const signature = vp8l();
  signature[8] = 0x2e;
  assert.equal(statusOf(webp(signature)), "invalid");
  const version = vp8l();
  version[12] |= 0x20;
  assert.equal(statusOf(webp(version)), "invalid");
  assert.equal(statusOf(lossless.subarray(0, lossless.length - 4)), "invalid");
  assert.equal(statusOf(webp(vp8l(15, 16))), "dimensions");
  assert.equal(statusOf(webp(vp8(16, 4097))), "dimensions");
});

test("IMG-7 every other file is refused: SVG, GIF, HTML and polyglot prefixes (unsupported); over 900,000 bytes (too_large, before parsing); a value that is not bytes (invalid)", () => {
  assert.equal(statusOf(SVG), "unsupported");
  assert.equal(
    statusOf(Buffer.from(`<?xml version="1.0"?>${SVG}`)),
    "unsupported",
  );
  assert.equal(statusOf(GIF), "unsupported");
  assert.equal(statusOf(HTML), "unsupported");
  assert.equal(statusOf(Buffer.concat([HTML, cleanPng()])), "unsupported");
  assert.equal(statusOf(Buffer.alloc(0)), "unsupported");
  assert.equal(
    statusOf(Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE", "latin1")),
    "unsupported",
  );
  const big = Buffer.concat([cleanPng(), Buffer.alloc(MAX_ASSET_BYTES)]);
  assert.equal(statusOf(big), "too_large");
  assert.equal(statusOf(Buffer.alloc(MAX_ASSET_BYTES + 1)), "too_large");
  assert.equal(inspectImage("not bytes").status, "invalid");
  assert.equal(inspectImage([0x89, 0x50]).status, "invalid");
  assert.equal(inspectImage(null).status, "invalid");
});

test("IMG-8 base64 and CRC helpers: standard padded base64 round-trips like Node's encoder and refuses whitespace, URL-safe characters and non-zero padding bits; CRC-32 equals zlib's", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 255, 1024]) {
    const bytes = randomBytes(length);
    const text = base64Of(u8(bytes));
    assert.equal(text, bytes.toString("base64"));
    assert.deepEqual(Buffer.from(bytesOfBase64(text)), bytes);
  }
  for (const bad of [
    "Zm9v\n",
    "Zm9",
    "Zm9v_-==",
    "Zh==",
    "Zm9=v",
    " Zm9v",
    "Zm9v=",
    1,
    null,
  ]) {
    assert.equal(bytesOfBase64(bad), null, String(bad));
  }
  assert.deepEqual(bytesOfBase64(""), new Uint8Array(0));
  for (const length of [0, 1, 13, 4096]) {
    const bytes = randomBytes(length);
    assert.equal(crc32(u8(bytes)), zlib.crc32(bytes) >>> 0);
  }
});

test("IMG-9 the module is pure: no Node built-in, platform buffer or dependency; it imports only the schema's types", () => {
  const source = readFileSync(
    new URL("../src/application/appearance-image.ts", import.meta.url),
    "utf8",
  );
  const imports = [...source.matchAll(/^import[^;]*from "([^"]+)";$/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(imports, ["./appearance-schema.ts"]);
  assert.match(
    source,
    /^import type \{ AssetFormat \} from "\.\/appearance-schema\.ts";$/m,
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /\bBuffer\b|\brequire\(|\bimport\(|node:|\bfetch\(/,
  );
});
