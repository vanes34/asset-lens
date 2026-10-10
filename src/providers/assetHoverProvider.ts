import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { readImageSize, ImageSize } from '../resolver/imageSize';
import { AssetResolver } from '../resolver/assetResolver';
import { ConversionOptions } from '../resolver/jsxSvg';
import { ResolvedPreview } from '../types';

const MAX_INLINE_SVG_BYTES = 256 * 1024;
const MIN_DISPLAY_SIZE = 48;

interface PreviewSettings {
  previewSize: number;
  previewColor: string;
  maxImageSize: number;
}

export class AssetHoverProvider implements vscode.HoverProvider {
  readonly resolver: AssetResolver;

  constructor(resolver?: AssetResolver) {
    this.resolver = resolver ?? new AssetResolver({ readFile: readUnsavedDocument });
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const settings = readSettings(document);
    let resolved: ResolvedPreview | undefined;
    try {
      resolved = this.resolver.resolvePreviewAtPosition(
        document.uri.fsPath,
        document.getText(),
        document.offsetAt(position),
        conversionOptions(settings),
      );
    } catch (error) {
      console.error('[asset-export-preview] Failed to resolve hover target', error);
      return undefined;
    }
    if (!resolved || token.isCancellationRequested) return undefined;

    const range = new vscode.Range(
      document.positionAt(resolved.range.start),
      document.positionAt(resolved.range.end),
    );

    try {
      const markdown = await this.renderPreview(resolved, settings);
      if (!markdown || token.isCancellationRequested) return undefined;
      return new vscode.Hover(markdown, range);
    } catch (error) {
      console.error('[asset-export-preview] Failed to render hover preview', error);
      return undefined;
    }
  }

  private async renderPreview(resolved: ResolvedPreview, settings: PreviewSettings): Promise<vscode.MarkdownString | undefined> {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = false;
    markdown.supportHtml = false;

    if (resolved.kind === 'asset') {
      const stat = await fs.promises.stat(resolved.assetPath).catch(() => undefined);
      if (!stat?.isFile()) return undefined;

      const assetUri = vscode.Uri.file(resolved.assetPath);
      const extension = path.extname(resolved.assetPath).slice(1).toUpperCase();
      const size = await readImageSize(resolved.assetPath);
      const details = [extension, size && `${formatNumber(size.width)}×${formatNumber(size.height)}`, formatBytes(stat.size)];

      markdown.appendMarkdown(`**${escapeMarkdown(resolved.exportName)}** · ${details.filter(Boolean).join(' · ')}\n\n`);
      markdown.appendMarkdown(`![${escapeMarkdown(resolved.exportName)}](${assetUri.toString()}${displayDimensions(size, settings.maxImageSize)})\n\n`);
      markdown.appendMarkdown(`[${escapeMarkdown(relativePath(resolved.assetPath))}](${assetUri.toString()})`);
      return markdown;
    }

    const sourceUri = vscode.Uri.file(resolved.sourcePath);
    const sourceLink = `[${escapeMarkdown(relativePath(resolved.sourcePath))}](${sourceUri.toString()})`;
    const title = `**${escapeMarkdown(resolved.exportName)}** · SVG component`;

    if (resolved.kind === 'unsupported') {
      markdown.appendMarkdown(`${title}\n\n`);
      markdown.appendMarkdown(`_No preview available:_ ${escapeMarkdown(resolved.reason)}\n\n`);
      markdown.appendMarkdown(sourceLink);
      return markdown;
    }

    markdown.appendMarkdown(`${title}${resolved.originalSize ? ` · ${resolved.originalSize}` : ''}\n\n`);
    const bytes = Buffer.byteLength(resolved.svgMarkup, 'utf8');
    if (bytes > MAX_INLINE_SVG_BYTES) {
      markdown.appendMarkdown(`_Preview skipped: generated SVG is ${formatBytes(bytes)}._\n\n`);
    } else {
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(resolved.svgMarkup, 'utf8').toString('base64')}`;
      markdown.appendMarkdown(`![${escapeMarkdown(resolved.exportName)}](${dataUri})\n\n`);
    }
    for (const warning of resolved.warnings) {
      markdown.appendMarkdown(`_${escapeMarkdown(warning)}_\n\n`);
    }
    markdown.appendMarkdown(sourceLink);
    return markdown;
  }
}

function readSettings(document: vscode.TextDocument): PreviewSettings {
  const configuration = vscode.workspace.getConfiguration('assetExportPreview', document.uri);
  return {
    previewSize: clamp(configuration.get<number>('previewSize', 64), 16, 512),
    previewColor: configuration.get<string>('previewColor', '').trim(),
    maxImageSize: clamp(configuration.get<number>('maxImageSize', 256), 32, 1024),
  };
}

function conversionOptions(settings: PreviewSettings): ConversionOptions {
  return { size: settings.previewSize, color: settings.previewColor || themeColor() };
}

function themeColor(): string {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? '#424242' : '#cccccc';
}

function readUnsavedDocument(filePath: string): string | undefined {
  const document = vscode.workspace.textDocuments.find((doc) => doc.isDirty && doc.uri.scheme === 'file' && doc.uri.fsPath === filePath);
  return document?.getText();
}

function displayDimensions(size: ImageSize | undefined, maxSize: number): string {
  if (!size || size.width <= 0 || size.height <= 0) return '';
  const longest = Math.max(size.width, size.height);
  let scale = Math.min(1, maxSize / longest);
  if (longest < MIN_DISPLAY_SIZE) scale = Math.min(4, MIN_DISPLAY_SIZE / longest);
  return `|width=${Math.max(1, Math.round(size.width * scale))},height=${Math.max(1, Math.round(size.height * scale))}`;
}

function relativePath(filePath: string): string {
  return vscode.workspace.asRelativePath(filePath, false);
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
