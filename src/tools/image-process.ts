/** Image normalisation for the model: HEIC → JPEG (heic-convert; sharp's prebuilt libheif has no HEVC), GIF/animated →
 * first frame, EXIF rotation, resize to ≤1500px on the long side, re-encode as JPEG (or PNG for small/alpha images). */
import sharp from 'sharp';
import heicConvert from 'heic-convert';

export const MAX_SIDE = 1500;
const PNG_MAX_BYTES = 1_500_000;

export interface ProcessedImage {
  mediaType: 'image/jpeg' | 'image/png';
  data: Buffer;
  width: number;
  height: number;
}

/** ISO-BMFF brand sniffing: 'ftypheic', 'ftypheix', 'ftypmif1', … */
export function isHeic(buf: Buffer, mimetype?: string | null, name?: string | null): boolean {
  if (mimetype && /image\/hei[cf]/i.test(mimetype)) return true;
  if (name && /\.hei[cf]$/i.test(name)) return true;
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

export async function processImage(input: Buffer, hint: { mimetype?: string | null; name?: string | null } = {}): Promise<ProcessedImage> {
  let buf: Buffer = input;
  if (isHeic(buf, hint.mimetype, hint.name)) {
    try {
      const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 });
      buf = Buffer.isBuffer(out) ? out : Buffer.from(new Uint8Array(out));
    } catch (err) {
      // Some ".heic" files are really AVIF/JPEG — let sharp try the original.
      buf = input;
    }
  }
  // `pages: 1` (the default) = first frame of GIF/animated WebP.
  const img = sharp(buf, { pages: 1, failOn: 'none', limitInputPixels: 100_000_000 }).rotate();
  const meta = await img.metadata();
  const resized = img.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
  const keepPng = meta.format === 'png' || meta.format === 'gif' || !!meta.hasAlpha;
  if (keepPng) {
    const png = await resized.clone().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    if (png.data.length <= PNG_MAX_BYTES) return { mediaType: 'image/png', data: png.data, width: png.info.width, height: png.info.height };
  }
  const jpg = await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { mediaType: 'image/jpeg', data: jpg.data, width: jpg.info.width, height: jpg.info.height };
}
