/**
 * Shrinking a phone photograph before it is uploaded.
 *
 * ---------------------------------------------------------------------------
 * THIS IS WHY THE PHOTOGRAPHS CAN LIVE IN THE DATABASE.
 *
 * A photograph straight off a modern phone is four to six megabytes and around
 * 4000 pixels wide. Nothing about a scratched laptop lid needs that: the
 * picture is looked at on a phone or a counter iPad, and 1600 pixels on its
 * long edge is more than either can show. Downscaling here rather than on the
 * server means the big file never crosses the shop WiFi at all, the API needs
 * no image library, and a year of evidence is a few hundred megabytes instead
 * of tens of gigabytes.
 *
 * Done with the browser's own canvas — no dependency. `imageOrientation` is the
 * detail that matters on a phone: without it, a portrait photograph arrives
 * rotated on its side, because phones record the rotation as EXIF metadata
 * rather than rotating the pixels.
 * ---------------------------------------------------------------------------
 */

export interface PreparedPhoto {
  readonly base64: string;
  readonly contentType: 'image/jpeg';
  readonly bytes: number;
}

/** Anything wider or taller than this is scaled down to it, keeping the shape. */
const MAX_EDGE = 1600;

/** The server's ceiling, mirrored so we fail here rather than after an upload. */
const MAX_BYTES = 2 * 1024 * 1024;

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not an image.');
  }

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot resize images.');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Step the quality down rather than refuse: a detailed photograph at 1600px
  // can still exceed the ceiling, and a slightly softer picture is a better
  // outcome than "upload failed" while a customer waits at the counter.
  for (const quality of [0.75, 0.6, 0.45]) {
    const blob = await toBlob(canvas, quality);
    if (blob.size <= MAX_BYTES) {
      return {
        base64: await toBase64(blob),
        contentType: 'image/jpeg',
        bytes: blob.size,
      };
    }
  }

  throw new Error('That photograph is too detailed to store. Try another shot.');
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      'image/jpeg',
      quality,
    );
  });
}

/** Base64 WITHOUT the data-URL prefix — the API wants the payload alone. */
async function toBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked: spreading a megabyte-long array into String.fromCharCode at once
  // overflows the call stack on Safari.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
