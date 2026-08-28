/**
 * Base64 encoding for the recorded WAV that gets uploaded to the server-side
 * pronunciation assessment.
 *
 * Chunked on purpose: `String.fromCharCode(...bytes)` on a multi-megabyte
 * recording blows the JS argument limit (RangeError: too many arguments) on
 * every engine, and a minute of 16 kHz mono 16-bit audio is ~2 MB.
 */
const CHUNK_SIZE = 0x8000; // 32 KiB per fromCharCode call

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

export async function fileToBase64(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}
