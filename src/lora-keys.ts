export function deriveLoraDestKey(castId: number, timestamp: number): string {
  return `loras/cast-${castId}/${timestamp}.safetensors`;
}
