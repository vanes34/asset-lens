import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ImageSize {
  width: number;
  height: number;
}

const MAX_HEADER_BYTES = 512 * 1024;

export async function readImageSize(filePath: string): Promise<ImageSize | undefined> {
  try {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.svg') return svgSize(await fs.promises.readFile(filePath, 'utf8'));

    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_HEADER_BYTES, 0);
      return imageSizeFromBuffer(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export function imageSizeFromBuffer(buffer: Buffer): ImageSize | undefined {
  try {
    return png(buffer) ?? gif(buffer) ?? bmp(buffer) ?? jpeg(buffer) ?? webp(buffer) ?? avif(buffer) ?? ico(buffer);
  } catch {
    return undefined;
  }
}

export function svgSize(markup: string): ImageSize | undefined {
  const root = /<svg\b[^>]*>/i.exec(markup)?.[0];
  if (!root) return undefined;
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];

  const width = parseFloat(attribute('width') ?? '');
  const height = parseFloat(attribute('height') ?? '');
  const isPercent = /%/.test(attribute('width') ?? '') || /%/.test(attribute('height') ?? '');
  if (width > 0 && height > 0 && !isPercent) return { width, height };

  const viewBox = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) return { width: viewBox[2], height: viewBox[3] };
  return undefined;
}

function png(b: Buffer): ImageSize | undefined {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): ImageSize | undefined {
  if (b.length < 10 || b.toString('ascii', 0, 3) !== 'GIF') return undefined;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function bmp(b: Buffer): ImageSize | undefined {
  if (b.length < 26 || b.toString('ascii', 0, 2) !== 'BM') return undefined;
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

function jpeg(b: Buffer): ImageSize | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = b[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    offset += 2 + b.readUInt16BE(offset + 2);
  }
  return undefined;
}

function webp(b: Buffer): ImageSize | undefined {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return undefined;
}

function avif(b: Buffer): ImageSize | undefined {
  if (b.length < 16 || b.toString('ascii', 4, 8) !== 'ftyp') return undefined;
  const index = b.indexOf('ispe', 0, 'ascii');
  if (index === -1 || index + 16 > b.length) return undefined;
  return { width: b.readUInt32BE(index + 8), height: b.readUInt32BE(index + 12) };
}

function ico(b: Buffer): ImageSize | undefined {
  if (b.length < 8 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return undefined;
  return { width: b[6] || 256, height: b[7] || 256 };
}
