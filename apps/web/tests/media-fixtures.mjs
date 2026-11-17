// MVP-001 S3: synthetic WebM (Opus) and MP4 (AAC) byte fixtures, built here
// from their container rules. No real recording is used; every frame is a
// minimal synthetic Opus or AAC packet of the right declared duration.

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));

// ---------------------------------------------------------------------------
// EBML / WebM
// ---------------------------------------------------------------------------

function idBytes(id) {
  const bytes = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return bytes;
}

// An 8-byte EBML size.
function size8(n) {
  const bytes = [0x01];
  for (let i = 6; i >= 0; i -= 1) {
    bytes.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
  }
  return bytes;
}

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

export function ebml(id, payload) {
  return [...idBytes(id), ...size8(payload.length), ...payload];
}

export function ebmlUnknown(id, payload) {
  return [...idBytes(id), ...UNKNOWN_SIZE, ...payload];
}

function uint(n, length) {
  const bytes = [];
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
  }
  return bytes;
}

function float64(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return [...new Uint8Array(view.buffer)];
}

export const OPUS_20MS_TOC = 0xf8; // CELT, 20 ms, one frame
const OPUS_FRAME = [0x01, 0x02, 0x03];

export function webmHeader(docType = "webm") {
  return ebml(0x1a45dfa3, [
    ...ebml(0x4286, [1]),
    ...ebml(0x42f7, [1]),
    ...ebml(0x42f2, [4]),
    ...ebml(0x42f3, [8]),
    ...ebml(0x4282, ascii(docType)),
    ...ebml(0x4287, [4]),
    ...ebml(0x4285, [2]),
  ]);
}

export function webmTrack({ number = 1, type = 2, codec = "A_OPUS" } = {}) {
  return ebml(0xae, [
    ...ebml(0xd7, [number]),
    ...ebml(0x73c5, [number]),
    ...ebml(0x83, [type]),
    ...ebml(0x86, ascii(codec)),
  ]);
}

export function simpleBlock(
  relative,
  frames = [[OPUS_20MS_TOC, ...OPUS_FRAME]],
  { track = 1, lacing = 0 } = {},
) {
  const rel = relative & 0xffff;
  let payload;
  if (lacing === 0) {
    payload = frames[0];
  } else {
    // Xiph lacing: frame count - 1, then the sizes of all but the last.
    const sizes = [];
    for (const frame of frames.slice(0, -1)) {
      let n = frame.length;
      while (n >= 255) {
        sizes.push(255);
        n -= 255;
      }
      sizes.push(n);
    }
    payload = [frames.length - 1, ...sizes, ...frames.flat()];
  }
  return ebml(0xa3, [
    0x80 | track,
    rel >> 8,
    rel & 0xff,
    0x80 | (lacing === 0 ? 0 : 0x02),
    ...payload,
  ]);
}

// A WebM recording as browsers write it: unknown-size Segment and Clusters,
// optionally without a duration header, one Opus packet every 20 ms.
export function webmRecording({
  durationMs,
  infoDurationMs = null,
  clusterMs = 1000,
  tracks = [webmTrack()],
  docType = "webm",
  packetMs = 20,
  squeeze = false,
} = {}) {
  const info = ebml(0x1549a966, [
    ...ebml(0x2ad7b1, uint(1_000_000, 3)),
    ...(infoDurationMs === null ? [] : ebml(0x4489, float64(infoDurationMs))),
  ]);
  const parts = [info, ebml(0x1654ae6b, tracks.flat())];
  for (let start = 0; start < durationMs; start += clusterMs) {
    const blocks = [];
    for (
      let t = start;
      t < Math.min(start + clusterMs, durationMs);
      t += packetMs
    ) {
      blocks.push(...simpleBlock(squeeze ? 0 : t - start));
    }
    parts.push(
      ebmlUnknown(0x1f43b675, [
        ...ebml(0xe7, uint(squeeze ? 0 : start, 4)),
        ...blocks,
      ]),
    );
  }
  return Uint8Array.from([
    ...webmHeader(docType),
    ...ebmlUnknown(0x18538067, parts.flat()),
  ]);
}

// ---------------------------------------------------------------------------
// ISO base media / MP4
// ---------------------------------------------------------------------------

const u32 = (n) => uint(n, 4);

export function box(type, payload) {
  return [...u32(8 + payload.length), ...ascii(type), ...payload];
}

function fullBox(type, version, flags, payload) {
  return box(type, [version, ...uint(flags, 3), ...payload]);
}

const zeros = (n) => new Array(n).fill(0);

function mvhd(timescale, duration) {
  return fullBox("mvhd", 0, 0, [
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(duration),
    ...zeros(80),
  ]);
}

function trak({ handler, codec, timescale, mediaDuration, sttsSamples }) {
  return box("trak", [
    ...fullBox("tkhd", 0, 3, [
      ...u32(0),
      ...u32(0),
      ...u32(1),
      ...u32(0),
      ...u32(0),
      ...zeros(60),
    ]),
    ...box("mdia", [
      ...fullBox("mdhd", 0, 0, [
        ...u32(0),
        ...u32(0),
        ...u32(timescale),
        ...u32(mediaDuration),
        0x55,
        0xc4,
        0,
        0,
      ]),
      ...fullBox("hdlr", 0, 0, [...u32(0), ...ascii(handler), ...zeros(12), 0]),
      ...box("minf", [
        ...box("stbl", [
          ...fullBox("stsd", 0, 0, [...u32(1), ...box(codec, zeros(28))]),
          ...fullBox(
            "stts",
            0,
            0,
            sttsSamples === 0
              ? u32(0)
              : [...u32(1), ...u32(sttsSamples), ...u32(1024)],
          ),
        ]),
      ]),
    ]),
  ]);
}

// A progressive AAC MP4: movie and media durations as declared, and a
// sample table of AAC frames (1024 samples each).
export function mp4Recording({
  frames,
  timescale = 48_000,
  movieDuration = frames * 1024,
  mediaDuration = frames * 1024,
  handler = "soun",
  codec = "mp4a",
  extraTrak = false,
  ftypFirst = true,
} = {}) {
  const track = trak({
    handler,
    codec,
    timescale,
    mediaDuration,
    sttsSamples: frames,
  });
  const moov = box("moov", [
    ...mvhd(timescale, movieDuration),
    ...track,
    ...(extraTrak ? track : []),
  ]);
  const ftyp = box("ftyp", [
    ...ascii("M4A "),
    ...u32(0),
    ...ascii("isom"),
    ...ascii("M4A "),
  ]);
  const mdat = box("mdat", zeros(frames));
  return Uint8Array.from(
    ftypFirst ? [...ftyp, ...moov, ...mdat] : [...moov, ...ftyp, ...mdat],
  );
}

// A fragmented AAC MP4 as some recorders write it: zero durations in the
// headers, a default sample duration, and one fragment per second.
export function fragmentedMp4Recording({ seconds, timescale = 48_000 }) {
  const ftyp = box("ftyp", [
    ...ascii("iso5"),
    ...u32(0),
    ...ascii("iso5"),
    ...ascii("dash"),
  ]);
  const moov = box("moov", [
    ...mvhd(timescale, 0),
    ...trak({
      handler: "soun",
      codec: "mp4a",
      timescale,
      mediaDuration: 0,
      sttsSamples: 0,
    }),
    ...box("mvex", [
      ...fullBox("trex", 0, 0, [
        ...u32(1),
        ...u32(1),
        ...u32(1024),
        ...u32(0),
        ...u32(0),
      ]),
    ]),
  ]);
  const fragments = [];
  const perFragment = Math.round(timescale / 1024);
  for (let i = 0; i < seconds; i += 1) {
    fragments.push(
      ...box("moof", [
        ...fullBox("mfhd", 0, 0, u32(i + 1)),
        ...box("traf", [
          ...fullBox("tfhd", 0, 0x020000, u32(1)),
          ...fullBox("tfdt", 0, 0, u32(i * perFragment * 1024)),
          ...fullBox("trun", 0, 0x000001, [...u32(perFragment), ...u32(0)]),
        ]),
      ]),
      ...box("mdat", zeros(perFragment)),
    );
  }
  return Uint8Array.from([...ftyp, ...moov, ...fragments]);
}

// ---------------------------------------------------------------------------
// Verification artifacts
// ---------------------------------------------------------------------------

export const SYNTHETIC_PDF = Uint8Array.from(
  ascii("%PDF-1.4\n% synthetic\n1 0 obj << >> endobj\n%%EOF\n"),
);
export const SYNTHETIC_PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
  ...ascii("IHDR"),
  ...zeros(17),
]);
export const SYNTHETIC_JPEG = Uint8Array.from([
  0xff,
  0xd8,
  0xff,
  0xe0,
  ...zeros(16),
  0xff,
  0xd9,
]);
export const SYNTHETIC_HTML = Uint8Array.from(
  ascii("<!doctype html><script>synthetic</script>"),
);
export const SYNTHETIC_SVG = Uint8Array.from(
  ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
);
export const SYNTHETIC_OGG = Uint8Array.from([...ascii("OggS"), ...zeros(60)]);
export const SYNTHETIC_WAV = Uint8Array.from([
  ...ascii("RIFF"),
  ...u32(36),
  ...ascii("WAVEfmt "),
  ...zeros(40),
]);
