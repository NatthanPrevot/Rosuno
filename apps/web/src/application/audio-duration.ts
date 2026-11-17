// Voice memo container recognition and duration measurement (MVP-001 S3;
// MBS section 8 "voice memo length limit is enforced server-side").
//
// Pure and dependency-free: it reads only the bytes the server received and
// never a duration, type, or name the browser reported. Two containers are
// recognized, each with one audio track only:
// - audio/webm: a Matroska/WebM file (EBML DocType "webm") with one Opus
//   track. Browser recorders usually write no duration header and an
//   unknown-size Segment and Clusters, so the duration is computed from the
//   Cluster and Block timecodes and from the Opus packets themselves;
// - audio/mp4: an ISO base media file with one sound track (AAC "mp4a" or
//   "Opus"), progressive or fragmented: the movie and media headers, the
//   fragment duration, the sample time table, and every fragment run.
// The measured duration is the largest of every duration signal the file
// carries, so a file can never claim less than it holds. Anything else, and
// any file whose structure does not hold together, is refused: unsupported
// when the container is not recognized at all, malformed when it is but
// cannot be read completely and consistently.

export const RECORDING_TYPES = Object.freeze([
  "audio/webm",
  "audio/mp4",
] as const);

export type RecordingType = (typeof RECORDING_TYPES)[number];

export type RecordingMeasure =
  | {
      readonly kind: "measured";
      readonly type: RecordingType;
      // Milliseconds, never negative, possibly fractional.
      readonly durationMs: number;
    }
  | { readonly kind: "unsupported" }
  | { readonly kind: "malformed" };

const UNSUPPORTED: RecordingMeasure = Object.freeze({ kind: "unsupported" });
const MALFORMED: RecordingMeasure = Object.freeze({ kind: "malformed" });

// Work bounds: no input may make the reader visit more elements than this.
const MAX_ELEMENTS = 200_000;
const MAX_DEPTH = 12;

class Malformed extends Error {}

function fail(): never {
  throw new Malformed();
}

function measured(type: RecordingType, durationMs: number): RecordingMeasure {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return MALFORMED;
  }
  return Object.freeze({ kind: "measured", type, durationMs });
}

export function measureRecording(bytes: Uint8Array): RecordingMeasure {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    return UNSUPPORTED;
  }
  try {
    if (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    ) {
      return measured("audio/webm", webmDurationMs(bytes));
    }
    if (
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return measured("audio/mp4", mp4DurationMs(bytes));
    }
    return UNSUPPORTED;
  } catch {
    // A structural refusal, or any read outside the bytes, is malformed.
    return MALFORMED;
  }
}

// ---------------------------------------------------------------------------
// Matroska / WebM
// ---------------------------------------------------------------------------

const EBML_HEADER = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const INFO_DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
const VOID = 0xec;
const CRC32 = 0xbf;

// The elements that may follow a Cluster at Segment level; an unknown-size
// Cluster ends where one of them begins.
const SEGMENT_LEVEL = new Set([
  0x114d9b74, // SeekHead
  INFO,
  TRACKS,
  CLUSTER,
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

// The elements a Cluster may hold.
const CLUSTER_CHILDREN = new Set([
  CLUSTER_TIMECODE,
  0x5854, // SilentTracks
  0xa7, // Position
  0xab, // PrevSize
  SIMPLE_BLOCK,
  BLOCK_GROUP,
  0xaf, // EncryptedBlock (refused when seen)
  VOID,
  CRC32,
]);

type Vint = { readonly value: number; readonly length: number };

// An EBML element ID: 1 to 4 bytes, marker bits kept.
function readId(bytes: Uint8Array, at: number, end: number): Vint {
  if (at >= end) {
    fail();
  }
  const first = bytes[at];
  const length =
    first & 0x80
      ? 1
      : first & 0x40
        ? 2
        : first & 0x20
          ? 3
          : first & 0x10
            ? 4
            : 0;
  if (length === 0 || at + length > end) {
    fail();
  }
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + bytes[at + i];
  }
  return { value, length };
}

// An EBML unsigned variable-length integer (marker removed): 1 to 8 bytes.
// unknown is set when every value bit is one (an unknown element size).
function readVint(
  bytes: Uint8Array,
  at: number,
  end: number,
): Vint & { readonly unknown: boolean } {
  if (at >= end) {
    fail();
  }
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && (first & (0x100 >> length)) === 0) {
    length += 1;
  }
  if (length > 8 || at + length > end) {
    fail();
  }
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) {
      allOnes = false;
    }
  }
  if (allOnes) {
    return { value: 0, length, unknown: true };
  }
  if (!Number.isSafeInteger(value)) {
    fail();
  }
  return { value, length, unknown: false };
}

function readUnsigned(bytes: Uint8Array, at: number, size: number): number {
  if (size < 1 || size > 8) {
    fail();
  }
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + bytes[at + i];
  }
  if (!Number.isSafeInteger(value)) {
    fail();
  }
  return value;
}

function readFloat(bytes: Uint8Array, at: number, size: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, size);
  if (size === 4) {
    return view.getFloat32(0);
  }
  if (size === 8) {
    return view.getFloat64(0);
  }
  return fail();
}

function readAscii(bytes: Uint8Array, at: number, size: number): string {
  let text = "";
  for (let i = 0; i < size; i += 1) {
    const code = bytes[at + i];
    if (code === 0) {
      break;
    }
    if (code < 0x20 || code > 0x7e) {
      fail();
    }
    text += String.fromCharCode(code);
  }
  return text;
}

type Element = {
  readonly id: number;
  readonly dataStart: number;
  // The end of the element's data; for an unknown size, the parent's end.
  readonly dataEnd: number;
  readonly unknownSize: boolean;
};

function readElement(bytes: Uint8Array, at: number, end: number): Element {
  const id = readId(bytes, at, end);
  const size = readVint(bytes, at + id.length, end);
  const dataStart = at + id.length + size.length;
  if (size.unknown) {
    return { id: id.value, dataStart, dataEnd: end, unknownSize: true };
  }
  const dataEnd = dataStart + size.value;
  if (dataEnd > end) {
    fail();
  }
  return { id: id.value, dataStart, dataEnd, unknownSize: false };
}

// Opus packet duration in 48 kHz samples, from its TOC byte (RFC 6716
// section 3.1), at most 120 ms (5760 samples).
const SILK_SAMPLES = [480, 960, 1920, 2880];
const HYBRID_SAMPLES = [480, 960];
const CELT_SAMPLES = [120, 240, 480, 960];

function opusPacketSamples(
  bytes: Uint8Array,
  start: number,
  length: number,
): number {
  if (length < 1) {
    fail();
  }
  const toc = bytes[start];
  const config = toc >> 3;
  const frameSamples =
    config < 12
      ? SILK_SAMPLES[config & 3]
      : config < 16
        ? HYBRID_SAMPLES[config & 1]
        : CELT_SAMPLES[config & 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) {
    frames = 1;
  } else if (code === 1 || code === 2) {
    frames = 2;
  } else {
    if (length < 2) {
      fail();
    }
    frames = bytes[start + 1] & 0x3f;
    if (frames < 1) {
      fail();
    }
  }
  const samples = frames * frameSamples;
  if (samples > 5760) {
    fail();
  }
  return samples;
}

// The frame sizes of one (Simple)Block's payload after its header.
function laceSizes(
  bytes: Uint8Array,
  start: number,
  end: number,
  lacing: number,
): readonly number[] {
  if (lacing === 0) {
    return [end - start];
  }
  if (start >= end) {
    fail();
  }
  const count = bytes[start] + 1;
  let at = start + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    for (let i = 0; i < count - 1; i += 1) {
      let size = 0;
      let byte: number;
      do {
        if (at >= end) {
          fail();
        }
        byte = bytes[at];
        at += 1;
        size += byte;
      } while (byte === 255);
      sizes.push(size);
    }
  } else if (lacing === 3) {
    const first = readVint(bytes, at, end);
    at += first.length;
    sizes.push(first.value);
    for (let i = 1; i < count - 1; i += 1) {
      const raw = readVint(bytes, at, end);
      at += raw.length;
      const bias = 2 ** (7 * raw.length - 1) - 1;
      const size = sizes[i - 1] + (raw.value - bias);
      if (!Number.isSafeInteger(size)) {
        fail();
      }
      sizes.push(size);
    }
  } else {
    const rest = end - at;
    if (rest % count !== 0) {
      fail();
    }
    return new Array(count).fill(rest / count);
  }
  const used = sizes.reduce((sum, size) => sum + size, 0);
  const last = end - at - used;
  sizes.push(last);
  if (sizes.some((size) => size < 1)) {
    fail();
  }
  return sizes;
}

type WebmState = {
  timecodeScale: number;
  infoDuration: number | null;
  trackNumber: number | null;
  trackCount: number;
  audioOpus: boolean;
  maxEndNs: number;
  sumNs: number;
  blocks: number;
  elements: number;
};

function countElement(state: WebmState): void {
  state.elements += 1;
  if (state.elements > MAX_ELEMENTS) {
    fail();
  }
}

function readInfo(bytes: Uint8Array, el: Element, state: WebmState): void {
  for (let at = el.dataStart; at < el.dataEnd;) {
    const child = readElement(bytes, at, el.dataEnd);
    countElement(state);
    if (child.unknownSize) {
      fail();
    }
    const size = child.dataEnd - child.dataStart;
    if (child.id === TIMECODE_SCALE) {
      const scale = readUnsigned(bytes, child.dataStart, size);
      if (scale < 1) {
        fail();
      }
      state.timecodeScale = scale;
    } else if (child.id === INFO_DURATION) {
      const duration = readFloat(bytes, child.dataStart, size);
      if (!Number.isFinite(duration) || duration < 0) {
        fail();
      }
      state.infoDuration = duration;
    }
    at = child.dataEnd;
  }
}

function readTracks(bytes: Uint8Array, el: Element, state: WebmState): void {
  for (let at = el.dataStart; at < el.dataEnd;) {
    const entry = readElement(bytes, at, el.dataEnd);
    countElement(state);
    if (entry.unknownSize) {
      fail();
    }
    if (entry.id === TRACK_ENTRY) {
      state.trackCount += 1;
      let number: number | null = null;
      let type: number | null = null;
      let codec: string | null = null;
      for (let inner = entry.dataStart; inner < entry.dataEnd;) {
        const field = readElement(bytes, inner, entry.dataEnd);
        countElement(state);
        if (field.unknownSize) {
          fail();
        }
        const size = field.dataEnd - field.dataStart;
        if (field.id === TRACK_NUMBER) {
          number = readUnsigned(bytes, field.dataStart, size);
        } else if (field.id === TRACK_TYPE) {
          type = readUnsigned(bytes, field.dataStart, size);
        } else if (field.id === CODEC_ID) {
          codec = readAscii(bytes, field.dataStart, size);
        }
        inner = field.dataEnd;
      }
      if (number === null || number < 1) {
        fail();
      }
      state.trackNumber = number;
      state.audioOpus = type === 2 && codec === "A_OPUS";
    }
    at = entry.dataEnd;
  }
}

function readBlock(
  bytes: Uint8Array,
  start: number,
  end: number,
  clusterTimecode: number | null,
  blockDuration: number | null,
  state: WebmState,
): void {
  if (clusterTimecode === null || state.trackNumber === null) {
    fail();
  }
  const track = readVint(bytes, start, end);
  const header = start + track.length;
  if (header + 3 > end || track.value !== state.trackNumber) {
    fail();
  }
  const relative = ((bytes[header] << 24) >> 16) | bytes[header + 1];
  const flags = bytes[header + 2];
  const lacing = (flags >> 1) & 3;
  const sizes = laceSizes(bytes, header + 3, end, lacing);
  let at = end - sizes.reduce((sum, size) => sum + size, 0);
  let samples = 0;
  for (const size of sizes) {
    samples += opusPacketSamples(bytes, at, size);
    at += size;
  }
  const scale = state.timecodeScale;
  const packetNs = (samples / 48_000) * 1e9;
  const durationNs = Math.max(
    packetNs,
    blockDuration === null ? 0 : blockDuration * scale,
  );
  const startNs = Math.max(0, (clusterTimecode + relative) * scale);
  state.maxEndNs = Math.max(state.maxEndNs, startNs + durationNs);
  state.sumNs += durationNs;
  state.blocks += 1;
}

function readBlockGroup(
  bytes: Uint8Array,
  el: Element,
  clusterTimecode: number | null,
  state: WebmState,
): void {
  let block: Element | null = null;
  let duration: number | null = null;
  for (let at = el.dataStart; at < el.dataEnd;) {
    const child = readElement(bytes, at, el.dataEnd);
    countElement(state);
    if (child.unknownSize) {
      fail();
    }
    if (child.id === BLOCK) {
      if (block !== null) {
        fail();
      }
      block = child;
    } else if (child.id === BLOCK_DURATION) {
      duration = readUnsigned(
        bytes,
        child.dataStart,
        child.dataEnd - child.dataStart,
      );
    }
    at = child.dataEnd;
  }
  if (block === null) {
    fail();
  }
  readBlock(
    bytes,
    block.dataStart,
    block.dataEnd,
    clusterTimecode,
    duration,
    state,
  );
}

// Reads one Cluster's children and answers where the Cluster ends.
function readCluster(bytes: Uint8Array, el: Element, state: WebmState): number {
  let clusterTimecode: number | null = null;
  let at = el.dataStart;
  while (at < el.dataEnd) {
    const id = readId(bytes, at, el.dataEnd);
    if (el.unknownSize && !CLUSTER_CHILDREN.has(id.value)) {
      if (!SEGMENT_LEVEL.has(id.value)) {
        fail();
      }
      return at;
    }
    const child = readElement(bytes, at, el.dataEnd);
    countElement(state);
    if (child.unknownSize) {
      fail();
    }
    const size = child.dataEnd - child.dataStart;
    if (child.id === CLUSTER_TIMECODE) {
      clusterTimecode = readUnsigned(bytes, child.dataStart, size);
    } else if (child.id === SIMPLE_BLOCK) {
      readBlock(
        bytes,
        child.dataStart,
        child.dataEnd,
        clusterTimecode,
        null,
        state,
      );
    } else if (child.id === BLOCK_GROUP) {
      readBlockGroup(bytes, child, clusterTimecode, state);
    } else if (child.id === 0xaf) {
      fail();
    }
    at = child.dataEnd;
  }
  return el.dataEnd;
}

function webmDurationMs(bytes: Uint8Array): number {
  const state: WebmState = {
    timecodeScale: 1_000_000,
    infoDuration: null,
    trackNumber: null,
    trackCount: 0,
    audioOpus: false,
    maxEndNs: 0,
    sumNs: 0,
    blocks: 0,
    elements: 0,
  };
  const header = readElement(bytes, 0, bytes.length);
  if (header.id !== EBML_HEADER || header.unknownSize) {
    fail();
  }
  let docType: string | null = null;
  for (let at = header.dataStart; at < header.dataEnd;) {
    const child = readElement(bytes, at, header.dataEnd);
    countElement(state);
    if (child.unknownSize) {
      fail();
    }
    if (child.id === DOC_TYPE) {
      docType = readAscii(
        bytes,
        child.dataStart,
        child.dataEnd - child.dataStart,
      );
    }
    at = child.dataEnd;
  }
  if (docType !== "webm") {
    fail();
  }
  let at = header.dataEnd;
  let segment: Element | null = null;
  while (at < bytes.length) {
    const el = readElement(bytes, at, bytes.length);
    countElement(state);
    if (el.id === SEGMENT) {
      if (segment !== null) {
        fail();
      }
      segment = el;
    } else if (el.id !== VOID || el.unknownSize) {
      fail();
    }
    at = el.dataEnd;
  }
  if (segment === null) {
    fail();
  }
  let infoSeen = false;
  let tracksSeen = false;
  for (let inner = segment.dataStart; inner < segment.dataEnd;) {
    const el = readElement(bytes, inner, segment.dataEnd);
    countElement(state);
    if (el.id === CLUSTER) {
      if (!tracksSeen) {
        fail();
      }
      inner = readCluster(bytes, el, state);
      continue;
    }
    if (el.unknownSize) {
      fail();
    }
    if (el.id === INFO) {
      if (infoSeen) {
        fail();
      }
      infoSeen = true;
      readInfo(bytes, el, state);
    } else if (el.id === TRACKS) {
      if (tracksSeen) {
        fail();
      }
      tracksSeen = true;
      readTracks(bytes, el, state);
    }
    inner = el.dataEnd;
  }
  if (
    !tracksSeen ||
    state.trackCount !== 1 ||
    !state.audioOpus ||
    state.blocks === 0
  ) {
    fail();
  }
  const infoNs =
    state.infoDuration === null ? 0 : state.infoDuration * state.timecodeScale;
  return Math.max(state.maxEndNs, state.sumNs, infoNs) / 1e6;
}

// ---------------------------------------------------------------------------
// ISO base media (MP4)
// ---------------------------------------------------------------------------

type Box = {
  readonly type: string;
  readonly dataStart: number;
  readonly end: number;
};

function u32(bytes: Uint8Array, at: number, end: number): number {
  if (at + 4 > end) {
    fail();
  }
  return (
    bytes[at] * 0x1000000 +
    ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])
  );
}

function u64(bytes: Uint8Array, at: number, end: number): number {
  const value = u32(bytes, at, end) * 0x100000000 + u32(bytes, at + 4, end);
  if (!Number.isFinite(value)) {
    fail();
  }
  return value;
}

function boxType(bytes: Uint8Array, at: number): string {
  let text = "";
  for (let i = 0; i < 4; i += 1) {
    const code = bytes[at + i];
    if (code < 0x20 || code > 0x7e) {
      fail();
    }
    text += String.fromCharCode(code);
  }
  return text;
}

function* boxesIn(
  bytes: Uint8Array,
  start: number,
  end: number,
  counter: { count: number },
): Generator<Box> {
  let at = start;
  while (at < end) {
    counter.count += 1;
    if (counter.count > MAX_ELEMENTS || at + 8 > end) {
      fail();
    }
    let size = u32(bytes, at, end);
    const type = boxType(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      size = u64(bytes, at + 8, end);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) {
      fail();
    }
    yield { type, dataStart: at + header, end: at + size };
    at += size;
  }
}

type Mp4State = {
  movieTimescale: number | null;
  movieDuration: number | null;
  fragmentDuration: number | null;
  tracks: number;
  soundTrackId: number | null;
  mediaTimescale: number | null;
  mediaDuration: number | null;
  sound: boolean;
  codecOk: boolean;
  sttsTicks: number;
  sttsSamples: number;
  trexDefaultDuration: number | null;
  fragmentEnd: number;
  fragmentSum: number;
  fragmentSamples: number;
  decodeCursor: number;
};

// Version 0 or 1 full-box header; answers the version and the payload start.
function fullBox(bytes: Uint8Array, box: Box): [number, number, number] {
  const header = u32(bytes, box.dataStart, box.end);
  const version = Math.floor(header / 0x1000000);
  if (version > 1) {
    fail();
  }
  return [version, header & 0xffffff, box.dataStart + 4];
}

// A declared duration; all ones means unknown.
function declared(value: number, version: number): number | null {
  const unknown = version === 1 ? 0xffffffffffffffff : 0xffffffff;
  return value === unknown ? null : value;
}

function readMvhd(bytes: Uint8Array, box: Box, state: Mp4State): void {
  const [version, , at] = fullBox(bytes, box);
  const timescale =
    version === 1 ? u32(bytes, at + 16, box.end) : u32(bytes, at + 8, box.end);
  const duration =
    version === 1 ? u64(bytes, at + 20, box.end) : u32(bytes, at + 12, box.end);
  if (timescale < 1) {
    fail();
  }
  state.movieTimescale = timescale;
  state.movieDuration = declared(duration, version);
}

function readTrak(
  bytes: Uint8Array,
  trak: Box,
  state: Mp4State,
  counter: { count: number },
  depth: number,
): void {
  state.tracks += 1;
  let trackId: number | null = null;
  const visit = (box: Box, level: number): void => {
    if (level > MAX_DEPTH) {
      fail();
    }
    if (box.type === "tkhd") {
      const [version, , at] = fullBox(bytes, box);
      trackId = u32(bytes, at + (version === 1 ? 16 : 8), box.end);
    } else if (box.type === "mdhd") {
      const [version, , at] = fullBox(bytes, box);
      const timescale =
        version === 1
          ? u32(bytes, at + 16, box.end)
          : u32(bytes, at + 8, box.end);
      const duration =
        version === 1
          ? u64(bytes, at + 20, box.end)
          : u32(bytes, at + 12, box.end);
      if (timescale < 1) {
        fail();
      }
      state.mediaTimescale = timescale;
      state.mediaDuration = declared(duration, version);
    } else if (box.type === "hdlr") {
      const [, , at] = fullBox(bytes, box);
      if (at + 8 > box.end) {
        fail();
      }
      state.sound = boxType(bytes, at + 4) === "soun";
    } else if (box.type === "stsd") {
      const [, , at] = fullBox(bytes, box);
      const entries = u32(bytes, at, box.end);
      if (entries !== 1 || at + 12 > box.end) {
        fail();
      }
      const format = boxType(bytes, at + 8);
      state.codecOk = format === "mp4a" || format === "Opus";
    } else if (box.type === "stts") {
      const [, , at] = fullBox(bytes, box);
      const entries = u32(bytes, at, box.end);
      if (at + 4 + entries * 8 > box.end) {
        fail();
      }
      for (let i = 0; i < entries; i += 1) {
        const samples = u32(bytes, at + 4 + i * 8, box.end);
        const delta = u32(bytes, at + 8 + i * 8, box.end);
        state.sttsSamples += samples;
        state.sttsTicks += samples * delta;
      }
    } else if (
      box.type === "mdia" ||
      box.type === "minf" ||
      box.type === "stbl"
    ) {
      for (const child of boxesIn(bytes, box.dataStart, box.end, counter)) {
        visit(child, level + 1);
      }
    }
  };
  for (const child of boxesIn(bytes, trak.dataStart, trak.end, counter)) {
    visit(child, depth + 1);
  }
  if (trackId === null) {
    fail();
  }
  state.soundTrackId = trackId;
}

function readMoov(
  bytes: Uint8Array,
  moov: Box,
  state: Mp4State,
  counter: { count: number },
): void {
  for (const box of boxesIn(bytes, moov.dataStart, moov.end, counter)) {
    if (box.type === "mvhd") {
      readMvhd(bytes, box, state);
    } else if (box.type === "trak") {
      readTrak(bytes, box, state, counter, 1);
    } else if (box.type === "mvex") {
      for (const child of boxesIn(bytes, box.dataStart, box.end, counter)) {
        if (child.type === "mehd") {
          const [version, , at] = fullBox(bytes, child);
          state.fragmentDuration =
            version === 1
              ? u64(bytes, at, child.end)
              : u32(bytes, at, child.end);
        } else if (child.type === "trex") {
          const [, , at] = fullBox(bytes, child);
          state.trexDefaultDuration = u32(bytes, at + 8, child.end);
        }
      }
    }
  }
}

function readTraf(
  bytes: Uint8Array,
  traf: Box,
  state: Mp4State,
  counter: { count: number },
): void {
  let defaultDuration = state.trexDefaultDuration;
  let decodeStart: number | null = null;
  let ticks = 0;
  let headerSeen = false;
  for (const box of boxesIn(bytes, traf.dataStart, traf.end, counter)) {
    if (box.type === "tfhd") {
      const [, flags, at] = fullBox(bytes, box);
      const trackId = u32(bytes, at, box.end);
      if (trackId !== state.soundTrackId) {
        fail();
      }
      headerSeen = true;
      let field = at + 4;
      if (flags & 0x01) {
        field += 8;
      }
      if (flags & 0x02) {
        field += 4;
      }
      if (flags & 0x08) {
        defaultDuration = u32(bytes, field, box.end);
      }
    } else if (box.type === "tfdt") {
      const [version, , at] = fullBox(bytes, box);
      decodeStart =
        version === 1 ? u64(bytes, at, box.end) : u32(bytes, at, box.end);
    } else if (box.type === "trun") {
      if (!headerSeen) {
        fail();
      }
      const [, flags, at] = fullBox(bytes, box);
      const samples = u32(bytes, at, box.end);
      let field = at + 4;
      if (flags & 0x01) {
        field += 4;
      }
      if (flags & 0x04) {
        field += 4;
      }
      const perSample =
        ((flags & 0x100) !== 0 ? 4 : 0) +
        ((flags & 0x200) !== 0 ? 4 : 0) +
        ((flags & 0x400) !== 0 ? 4 : 0) +
        ((flags & 0x800) !== 0 ? 4 : 0);
      if (field + samples * perSample > box.end) {
        fail();
      }
      if (flags & 0x100) {
        // One duration per sample, each inside the box (bounded by its size).
        for (let i = 0; i < samples; i += 1) {
          ticks += u32(bytes, field, box.end);
          field += perSample;
        }
      } else if (defaultDuration !== null) {
        ticks += samples * defaultDuration;
      } else {
        fail();
      }
      state.fragmentSamples += samples;
    }
  }
  if (!headerSeen) {
    fail();
  }
  const start = decodeStart ?? state.decodeCursor;
  state.decodeCursor = start + ticks;
  state.fragmentEnd = Math.max(state.fragmentEnd, start + ticks);
  state.fragmentSum += ticks;
}

function mp4DurationMs(bytes: Uint8Array): number {
  const state: Mp4State = {
    movieTimescale: null,
    movieDuration: null,
    fragmentDuration: null,
    tracks: 0,
    soundTrackId: null,
    mediaTimescale: null,
    mediaDuration: null,
    sound: false,
    codecOk: false,
    sttsTicks: 0,
    sttsSamples: 0,
    trexDefaultDuration: null,
    fragmentEnd: 0,
    fragmentSum: 0,
    fragmentSamples: 0,
    decodeCursor: 0,
  };
  const counter = { count: 0 };
  let first = true;
  let moovSeen = false;
  for (const box of boxesIn(bytes, 0, bytes.length, counter)) {
    if (first && box.type !== "ftyp") {
      fail();
    }
    first = false;
    if (box.type === "moov") {
      if (moovSeen) {
        fail();
      }
      moovSeen = true;
      readMoov(bytes, box, state, counter);
    } else if (box.type === "moof") {
      if (!moovSeen) {
        fail();
      }
      for (const child of boxesIn(bytes, box.dataStart, box.end, counter)) {
        if (child.type === "traf") {
          readTraf(bytes, child, state, counter);
        }
      }
    }
  }
  if (
    !moovSeen ||
    state.tracks !== 1 ||
    !state.sound ||
    !state.codecOk ||
    state.movieTimescale === null ||
    state.mediaTimescale === null ||
    state.sttsSamples + state.fragmentSamples === 0
  ) {
    fail();
  }
  const media = state.mediaTimescale;
  const movie = state.movieTimescale;
  const seconds = Math.max(
    state.movieDuration === null ? 0 : state.movieDuration / movie,
    state.mediaDuration === null ? 0 : state.mediaDuration / media,
    state.fragmentDuration === null ? 0 : state.fragmentDuration / movie,
    state.sttsTicks / media,
    state.fragmentEnd / media,
    state.fragmentSum / media,
  );
  return seconds * 1000;
}
