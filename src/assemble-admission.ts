/**
 * Pre-flight input-bytes admission check for a chunked assemble (cf#815).
 *
 * WHAT THIS BOUNDS, AND WHY IT IS NOT AN OUTPUT CAP. The container writes the assembled film to
 * local disk before streaming it to R2, and nothing bounds that write. Chunked assemble (cf#784)
 * flattened peak disk for the BATCH stage -- each batch dir is removed on flush and every partial
 * goes straight to R2 -- but it left the FINALIZE stage untouched:
 *
 *   containers/video-finish/app.py:315   `_silent.mp4`  <- the joined film
 *   containers/video-finish/app.py:786   `final.mp4`    <- _mux_bed_onto, written FROM _silent.mp4
 *
 * `_silent.mp4` is never removed (the only `os.remove` calls in the chunked path are the two that
 * reap batch partials, app.py:266 and :270), and the no-bed branch still writes `final.mp4` with
 * `-c copy` rather than renaming. So finalize holds TWO full-length copies of the film at once.
 * That is the term this check bounds. NOTE: the container's own comment at app.py:57-59 says
 * "peak disk at that stage is one film"; the code above says two, and this file follows the code.
 *
 * WHY THE THRESHOLD IS NOT `MAX_CLIPS x MAX_CLIP_BYTES`. cf#813 measures that product (80 x 256 MB
 * = 20.0 GB) as 23x to 120x above what a real film weighs, because `MAX_CLIP_BYTES` is the size at
 * which a DOWNLOAD is refused, not a payload. A gate written against it could never fire, which is
 * worse than no gate because it reads as protection. It is also the wrong QUANTITY: cf#813 measures
 * the normalized-to-source byte ratio at 0.98x to 5.09x, so source bytes do not predict the film.
 *
 * WHAT IT IS WRITTEN AGAINST INSTEAD: bitrate x duration, from cf#813's measured encodes through
 * this container's exact normalize command. See NORMALIZED_BITS_PER_PIXEL_FRAME.
 *
 * WHERE IT RUNS. On the Worker, before the first presign is minted. The Worker has the clip list
 * and the per-clip measured durations for free; the container learns a clip's length only by
 * downloading it. Refusing here costs nothing, refusing there costs the whole download.
 */

/**
 * Normalized video bits per pixel per frame at the container's encode settings
 * (`libx264 -crf 18 -preset medium`, containers/video-finish/app.py:612).
 *
 * DERIVED FROM cf#813's MEASUREMENT, not picked. Its 1080p24 band tops out at 11.16 Mbps:
 *
 *   11.16e6 bits/s / (1920 x 1080 x 24 px/s) = 0.2243 bits/px/frame
 *
 * Rounded UP to 0.225. Cross-checked against the same measurement's 720p24 ceiling, which is an
 * independent row: 0.225 x 1280 x 720 x 24 = 4.98 Mbps against a measured 4.82 Mbps, i.e. 3.3%
 * conservative. Bits-per-pixel being near-constant across the two resolutions is what lets one
 * number serve any delivery target instead of a per-resolution table that would rot.
 *
 * THE CEILING OF THE BAND, DELIBERATELY, and the direction of error is the point. This predicts
 * the LARGEST film a given input can normalize to, so the refusal comes early rather than after
 * the disk is already full. cf#813 also warns that its pan-based proxies UNDERESTIMATE real
 * generated video (no subject deformation, no per-frame diffusion shimmer), which argues for the
 * ceiling rather than the middle of the band as well.
 *
 * A film's predicted bytes are therefore an upper bound on its size and a lower bound on nothing:
 * a legitimate film lands well under, which is what keeps the CONTROL case admitted.
 */
export const NORMALIZED_BITS_PER_PIXEL_FRAME = 0.225;

/**
 * Ephemeral disk of the container instance the finish tier runs on.
 *
 * `instance_type = "standard-4"` (vivijure-cf wrangler.toml.example:238), documented there at
 * :201 as "the LARGEST Cloudflare offers (4 vCPU / 12 GiB / 20 GB disk)". Read as DECIMAL GB, the
 * smaller of the two readings, because guessing GiB here would silently widen the budget by 7%.
 */
export const CONTAINER_DISK_BYTES = 20_000_000_000;

/**
 * Full-length copies of the film resident on disk at once during finalize.
 *
 * TWO, not one: `_silent.mp4` then `final.mp4`, with no remove between them. See the file header
 * for the exact lines. This is the multiplier the whole check turns on, so it is a named constant
 * with its evidence rather than a `* 2` inline.
 */
export const FINALIZE_FILM_COPIES = 2;

/**
 * Peak disk the BATCH stage may occupy, mirroring the container's own budget at
 * containers/video-finish/app.py:49-50: `3 x (MAX_BATCH_BYTES + MAX_CLIP_BYTES)` -- a batch's
 * sources, their normalized copies, and the batch partial.
 *
 * Reserved even though the batch dirs are removed before the final join, so the two stages do not
 * in fact coexist. cf#815 asks for headroom for "the assembled film plus one batch working set",
 * and a reserve that survives a future reordering of those stages is worth 4 GB of a 20 GB disk.
 *
 * cf#813 argues this multiplier should be ~5x rather than 3x against SOURCE bytes, because the
 * normalized copy is roughly 2x its source while the fixed 1920x1080 target is still upscaling.
 * Correcting the container's constant is cf#813's acceptance item, not this one's; this reserve
 * deliberately quotes the container's CURRENT number so the two cannot silently disagree about
 * what is reserved today.
 */
export const CONTAINER_BATCH_PEAK_BYTES = 3 * (1024 * 1024 * 1024 + 256 * 1024 * 1024);

/** `MAX_AUDIO_BYTES`, containers/video-finish/app.py:41. The bed lands on disk beside the film. */
export const CONTAINER_AUDIO_BED_BYTES = 256 * 1024 * 1024;

/**
 * Disk the image, the OS and ffmpeg's own scratch occupy, which the film must not be allowed to
 * claim. A RESERVE, stated as one: it is not a measurement of the image, and it is deliberately
 * generous, because the cost of over-reserving is a lower film ceiling and the cost of
 * under-reserving is the ENOSPC this check exists to prevent.
 */
export const CONTAINER_IMAGE_RESERVE_BYTES = 2_000_000_000;

/**
 * Frames per second the container normalizes to when the payload omits `fps`.
 *
 * `int(body.get("fps", 24))`, containers/video-finish/app.py:391 (and :205, :1107).
 *
 * THREE NUMBERS HAVE TO AGREE HERE and a comment cannot make them: the container's fallback, core's
 * `DEFAULT_DELIVERY_FPS` (film-model.ts:1458), and this prediction. `assemble-admission.test.ts`
 * asserts this constant equals `DEFAULT_DELIVERY_FPS`, so a future edit to either one fails a test
 * rather than silently mispredicting every film by the ratio between them.
 */
export const CONTAINER_DEFAULT_FPS = 24;

/** The largest predicted film the container can finalize on its ephemeral disk. */
export function assembleFilmByteCeiling(): number {
  const reserved =
    CONTAINER_BATCH_PEAK_BYTES + CONTAINER_AUDIO_BED_BYTES + CONTAINER_IMAGE_RESERVE_BYTES;
  return Math.max(0, Math.floor((CONTAINER_DISK_BYTES - reserved) / FINALIZE_FILM_COPIES));
}

/** Predicted normalized bytes for `seconds` of video at a delivery target. */
export function predictNormalizedBytes(
  width: number,
  height: number,
  fps: number,
  seconds: number,
): number {
  if (!(width > 0) || !(height > 0) || !(fps > 0) || !(seconds > 0)) return 0;
  return Math.ceil((NORMALIZED_BITS_PER_PIXEL_FRAME * width * height * fps * seconds) / 8);
}

/** Seconds of film this assemble will produce, and how much of that is EVIDENCE. */
export interface AssembleSecondsBasis {
  /** Summed seconds of every clip whose length is known. */
  seconds: number;
  /** Clips whose length came from the container's own probe (delivered_frames / delivered_fps). */
  measured: number;
  /** Clips whose length came from the plan (bundle target_seconds, else the authored scene). */
  planned: number;
  /** Clips with neither. They contribute ZERO seconds, so `seconds` is a LOWER bound. */
  unknown: number;
}

/**
 * Resolve the film's length from what the Worker already holds.
 *
 * MEASURED WINS, PLAN FILLS, ABSENCE IS NAMED. This mirrors the #697 duration gate's discipline
 * (`findClipDurationShortfalls`): the check fires on EVIDENCE and never on absence, so a clip with
 * no known length cannot by itself refuse a film. It contributes zero seconds and is COUNTED, so
 * the caller can say the prediction is a lower bound instead of implying it is complete.
 *
 * A lower bound is still enough to refuse on: if the clips we CAN size already exceed the disk,
 * the ones we cannot size do not make the film smaller.
 */
export function resolveAssembleSeconds(
  finalClips: { shot_id: string }[],
  measuredSeconds: Map<string, number> | ReadonlyMap<string, number>,
  plannedSeconds: Record<string, number>,
): AssembleSecondsBasis {
  let seconds = 0;
  let measured = 0;
  let planned = 0;
  let unknown = 0;
  for (const c of finalClips ?? []) {
    if (!c || typeof c.shot_id !== "string") continue;
    const m = measuredSeconds?.get(c.shot_id);
    if (typeof m === "number" && Number.isFinite(m) && m > 0) {
      seconds += m;
      measured += 1;
      continue;
    }
    const p = plannedSeconds?.[c.shot_id];
    if (typeof p === "number" && Number.isFinite(p) && p > 0) {
      seconds += p;
      planned += 1;
      continue;
    }
    unknown += 1;
  }
  return { seconds, measured, planned, unknown };
}

export interface AssembleAdmissionInput {
  clipCount: number;
  width: number;
  height: number;
  fps?: number;
  basis: AssembleSecondsBasis;
}

export interface AssembleAdmission {
  admitted: boolean;
  predictedBytes: number;
  ceilingBytes: number;
  /** Seconds of film the ceiling allows at this delivery target. The actionable number. */
  allowedSeconds: number;
  basis: AssembleSecondsBasis;
  /** Loud, arithmetic-bearing refusal. Set only when `admitted` is false. */
  reason?: string;
}

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/**
 * Admit or refuse an assemble before a single byte is fetched.
 *
 * PURE. Every number it uses is either passed in or a constant above with its provenance, so the
 * arithmetic in the refusal is reproducible from the message alone.
 *
 * REFUSAL IS LOUD AND TERMINAL, never a degrade (cf#815, the #249/#77 discipline). A film that
 * cannot fit is not silently truncated to one that does: the caller is told what was asked, what
 * fits, by how much it is over, and what length would be accepted.
 */
export function admitAssemble(input: AssembleAdmissionInput): AssembleAdmission {
  const fps = input.fps && input.fps > 0 ? input.fps : CONTAINER_DEFAULT_FPS;
  const { width, height, basis, clipCount } = input;
  const ceilingBytes = assembleFilmByteCeiling();
  const predictedBytes = predictNormalizedBytes(width, height, fps, basis.seconds);
  const perSecond = predictNormalizedBytes(width, height, fps, 1);
  const allowedSeconds = perSecond > 0 ? Math.floor(ceilingBytes / perSecond) : 0;
  if (predictedBytes <= ceilingBytes) {
    return { admitted: true, predictedBytes, ceilingBytes, allowedSeconds, basis };
  }
  const over = predictedBytes - ceilingBytes;
  const bound = basis.unknown > 0 ? " (a LOWER bound: " + basis.unknown + " clip(s) of unknown length contributed 0s)" : "";
  const reason =
    `assemble refused before any clip was fetched: ${clipCount} clip(s) totalling ` +
    `${basis.seconds.toFixed(1)}s at ${width}x${height}@${fps} predict ${gb(predictedBytes)} of ` +
    `normalized video${bound}, and the container can finalize at most ${gb(ceilingBytes)}. ` +
    `Over by ${gb(over)}. Budget: ${gb(CONTAINER_DISK_BYTES)} ephemeral disk (standard-4), less ` +
    `${gb(CONTAINER_BATCH_PEAK_BYTES)} batch working set, ${gb(CONTAINER_AUDIO_BED_BYTES)} audio ` +
    `bed and ${gb(CONTAINER_IMAGE_RESERVE_BYTES)} image reserve, divided by ` +
    `${FINALIZE_FILM_COPIES} full-length copies resident at finalize. ` +
    `Basis: ${basis.measured} measured, ${basis.planned} planned, ${basis.unknown} unknown. ` +
    `This delivery target admits at most ${allowedSeconds}s; reduce the film, or lower ` +
    `delivery_width/delivery_height.`;
  return { admitted: false, predictedBytes, ceilingBytes, allowedSeconds, basis, reason };
}
