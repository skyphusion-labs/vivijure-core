/** Parse beat-trimmed per-shot target_seconds from a storyboard.yaml string. */
export function parseShotDurations(yaml: string): Record<string, number> {
  const out: Record<string, number> = {};
  let inScenes = false;
  let idx = 0;
  let curId: string | null = null;
  let curTarget: number | null = null;
  const flush = (): void => {
    if (idx === 0) return;
    const shot = curId || `shot_${String(idx).padStart(2, "0")}`;
    if (curTarget !== null && Number.isFinite(curTarget) && curTarget > 0) {
      out[shot] = curTarget;
    }
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (!inScenes) {
      if (/^scenes:\s*$/.test(line)) inScenes = true;
      continue;
    }
    if (/^ {2}-\s/.test(line)) {
      flush();
      idx++;
      curId = null;
      curTarget = null;
      continue;
    }
    const idM = line.match(/^ {4}id:\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (idM) {
      curId = idM[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const tsM = line.match(/^ {4}target_seconds:\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (tsM) {
      curTarget = parseFloat(tsM[1]);
      continue;
    }
  }
  flush();
  return out;
}
