// A synthetic but STRUCTURALLY REAL mp4, for gates that parse the box tree (cf#835).
//
// tests/clip-validate.test.ts already crafts a DEGENERATE file (ftyp + a header-only moov) because
// that is the defect it studies. A gate that fails a film needs the other half: a file that the
// same parser judges as a genuine film, or every "fail" it reports is unfalsifiable. So this builds
// the full nesting the parser walks, moov > trak > mdia > minf > stbl, with the four boxes it
// actually reads (mvhd for duration, tkhd for dimensions, hdlr for "is this video", stsz for the
// frame count) laid out to ISO 14496-12 offsets.

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One box: 4-byte big-endian size (header included) + 4-char type + payload. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(parts);
  return concat([u32be(payload.length + 8), ascii(type), payload]);
}

function at(size: number, writes: { offset: number; bytes: Uint8Array }[]): Uint8Array {
  const buf = new Uint8Array(size);
  for (const w of writes) buf.set(w.bytes, w.offset);
  return buf;
}

export interface CraftedFilm {
  durationS?: number;
  frames?: number;
  width?: number;
  height?: number;
  /** Pad the mdat so the object reaches at least this many bytes. */
  minBytes?: number;
  /** Omit the video track entirely (hdlr says "soun"), for the audio-only case. */
  audioOnly?: boolean;
}

/** Build a structurally valid mp4 whose mvhd/tkhd/hdlr/stsz say exactly what you asked for. */
export function craftFilmBytes(opts: CraftedFilm = {}): Uint8Array {
  const durationS = opts.durationS ?? 8;
  const frames = opts.frames ?? 192;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const timescale = 1000;

  // mvhd v0: version/flags(4) creation(4) modification(4) timescale(4) duration(4) + tail.
  const mvhd = box(
    "mvhd",
    at(100, [
      { offset: 12, bytes: u32be(timescale) },
      { offset: 16, bytes: u32be(Math.round(durationS * timescale)) },
    ]),
  );

  // tkhd v0: the last two 32-bit 16.16 fields of an 84-byte payload are width and height.
  const tkhd = box(
    "tkhd",
    at(84, [
      { offset: 12, bytes: u32be(1) }, // track_ID
      { offset: 76, bytes: u32be(width << 16) },
      { offset: 80, bytes: u32be(height << 16) },
    ]),
  );

  // hdlr: handler_type sits at payload offset 8.
  const hdlr = box(
    "hdlr",
    concat([new Uint8Array(8), ascii(opts.audioOnly ? "soun" : "vide"), new Uint8Array(20)]),
  );

  // stsz: version/flags(4) sample_size(4) sample_count(4).
  const stsz = box("stsz", concat([new Uint8Array(8), u32be(frames), new Uint8Array(8)]));

  const moov = box("moov", mvhd, box("trak", tkhd, box("mdia", hdlr, box("minf", box("stbl", stsz)))));
  const ftyp = box("ftyp", ascii("isom"), new Uint8Array(4));

  const minBytes = opts.minBytes ?? 8192;
  const pad = Math.max(0, minBytes - (ftyp.length + moov.length + 8));
  return concat([ftyp, moov, box("mdat", new Uint8Array(pad))]);
}

/** A fake R2 over a fixed key -> bytes map, answering HEAD and ranged GET the way R2 does. */
export function r2WithObjects(objects: Record<string, Uint8Array | number>) {
  const sizeOf = (v: Uint8Array | number): number => (typeof v === "number" ? v : v.length);
  return {
    head: async (key: string) => (key in objects ? { size: sizeOf(objects[key]) } : null),
    get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      const v = objects[key];
      // A number stands for "an object of this size whose BODY this fixture does not model", which
      // is how a bytes-only fixture asks for the unreadable-body path.
      if (v === undefined || typeof v === "number") return null;
      const off = opts?.range?.offset ?? 0;
      const len = opts?.range?.length ?? v.length - off;
      const slice = v.slice(off, off + len);
      return {
        arrayBuffer: async () =>
          slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      };
    },
  };
}
