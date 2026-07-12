export function needsAudioCrossBucketCopy(key: string): boolean {
  return key.startsWith("out/");
}
