export const ASSET_EXTENSIONS = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.ico'
]);

export const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'
];

export interface ResolvedAsset {
  assetPath: string;
  exportName: string;
}

export interface OffsetRange {
  start: number;
  end: number;
}

export type ResolvedPreview =
  | {
      kind: 'asset';
      exportName: string;
      assetPath: string;
      range: OffsetRange;
    }
  | {
      kind: 'jsx-svg';
      exportName: string;
      sourcePath: string;
      svgMarkup: string;
      warnings: string[];
      originalSize?: string;
      range: OffsetRange;
    }
  | {
      kind: 'unsupported';
      exportName: string;
      sourcePath: string;
      reason: string;
      range: OffsetRange;
    };
