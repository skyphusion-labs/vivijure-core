// Keyframe reuse, carried from the GPU backend to the render row (vivijure-cf#1385, core#532).
//
// The backend keeps a hash of each still's parameters. When a shot is asked for again with the same
// parameters, it draws nothing and returns the stored still, marked `reused: true` on that keyframe
// entry (vivijure-backend docs/contract.md, the `keyframes` row). The cf keyframe module forwards the
// mark and `KeyframeShot.reused` is in the module contract. Before this file the core dropped it at the
// job doc, so a panel "regen" with unchanged settings came back with the old still and read as a new
// take.
//
// THE CONTRACT has two states, not the three the plate count uses: `reused: true` means not drawn by
// this job, and an absent mark means drawn. So the view below is absent when no still was reused. Note
// what that cannot see: a backend or keyframe door that never reports the mark looks the same as one
// that drew every still.
//
// Only a JSON `true` is the mark. Any other value is not the documented shape and is dropped, so an odd
// value never claims a reuse that did not happen.

/** The render-level summary on `output.keyframe_reuse`. */
export interface KeyframeReuseView {
  /** Stills in this render. */
  stills: number;
  /** Shot ids of the stills the backend returned from its store instead of drawing, in keyframe order. */
  reused: string[];
}

/** Summarise reuse over a render's keyframes. Undefined when no still was reused (the contract's
 *  "absent means drawn"), so a render with no reuse gains no key. */
export function keyframeReuseView(
  keyframes: ReadonlyArray<{ shot_id: string; reused?: boolean }> | undefined,
): KeyframeReuseView | undefined {
  if (!keyframes?.length) return undefined;
  const reused = keyframes.filter((k) => k.reused === true).map((k) => k.shot_id);
  if (!reused.length) return undefined;
  return { stills: keyframes.length, reused };
}
