/** Identity of a PDF's bytes, independent of which Uint8Array carries them. */
const keyCache = new WeakMap<Uint8Array, string>();
/** Length plus two 32-bit FNV-1a variants over the whole file; ~1–3 ms for a typical paper. */
export function pdfContentKey(bytes: Uint8Array): string {
  const cached = keyCache.get(bytes);
  if (cached) return cached;
  let a = 0x811c9dc5, b = 0x01000193 ^ bytes.length;
  const words = Math.floor(bytes.byteLength / 4);
  // Same words whether or not the view is 4-byte aligned (little-endian, as on every browser platform).
  const aligned = bytes.byteOffset % 4 === 0 ? new Uint32Array(bytes.buffer, bytes.byteOffset, words) : null;
  const unaligned = aligned ? null : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < words; index++) {
    const word = aligned ? aligned[index] : unaligned!.getUint32(index * 4, true);
    a = Math.imul(a ^ word, 0x01000193);
    b = Math.imul(b ^ (word >>> 7), 0x5bd1e995) ^ (b >>> 13);
  }
  for (let index = words * 4; index < bytes.length; index++) {
    a = Math.imul(a ^ bytes[index], 0x01000193);
    b = Math.imul(b ^ bytes[index], 0x5bd1e995) ^ (b >>> 13);
  }
  const key = `${bytes.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
  keyCache.set(bytes, key);
  return key;
}
