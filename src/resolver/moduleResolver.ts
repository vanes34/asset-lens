import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { ASSET_EXTENSIONS, SOURCE_EXTENSIONS } from '../types';

interface PathMapping {
  basePath: string;
  paths: Record<string, string[]>;
  baseUrl?: string;
}

const EXPORT_CONDITIONS = ['source', 'development', 'import', 'module', 'browser', 'default', 'require', 'node'];
const PACKAGE_ENTRY_FIELDS = ['source', 'module', 'main'];

export class ModuleResolver {
  private readonly configByDirectory = new Map<string, PathMapping | null>();

  resolve(fromFile: string, rawSpecifier: string): string | undefined {
    const specifier = rawSpecifier.replace(/[?#].*$/, '');
    if (!specifier) return undefined;
    const fromDirectory = path.dirname(fromFile);
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      return resolveFileCandidates(path.resolve(fromDirectory, specifier));
    }
    return this.resolveAlias(fromDirectory, specifier) ?? this.resolvePackage(fromDirectory, specifier);
  }

  clearCache(): void {
    this.configByDirectory.clear();
  }

  private resolveAlias(fromDirectory: string, specifier: string): string | undefined {
    const mapping = this.findPathMapping(fromDirectory);
    if (!mapping) return undefined;

    let best: { pattern: string; captured: string; prefixLength: number } | undefined;
    for (const pattern of Object.keys(mapping.paths)) {
      const star = pattern.indexOf('*');
      if (star === -1) {
        if (pattern === specifier) best = { pattern, captured: '', prefixLength: Infinity };
        continue;
      }
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix) &&
        (!best || prefix.length > best.prefixLength)
      ) {
        best = { pattern, captured: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLength: prefix.length };
      }
    }

    if (best) {
      for (const target of mapping.paths[best.pattern]) {
        const resolved = resolveFileCandidates(path.resolve(mapping.basePath, target.replace('*', best.captured)));
        if (resolved) return resolved;
      }
    }
    return mapping.baseUrl ? resolveFileCandidates(path.resolve(mapping.baseUrl, specifier)) : undefined;
  }

  private findPathMapping(directory: string): PathMapping | undefined {
    const visited: string[] = [];
    let current = directory;
    let result: PathMapping | null | undefined;

    while (true) {
      if (this.configByDirectory.has(current)) {
        result = this.configByDirectory.get(current);
        break;
      }
      visited.push(current);
      const configFile = ['tsconfig.json', 'jsconfig.json']
        .map((name) => path.join(current, name))
        .find((file) => isFile(file));
      if (configFile) {
        result = readPathMapping(configFile);
        break;
      }
      const parent = path.dirname(current);
      if (parent === current || isFile(path.join(current, '.git')) || isDirectory(path.join(current, '.git'))) {
        result = null;
        break;
      }
      current = parent;
    }

    for (const visitedDirectory of visited) this.configByDirectory.set(visitedDirectory, result ?? null);
    return result ?? undefined;
  }

  private resolvePackage(fromDirectory: string, specifier: string): string | undefined {
    const parts = specifier.split('/');
    const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = specifier.slice(packageName.length);
    if (!packageName) return undefined;

    let current = fromDirectory;
    while (true) {
      const candidate = path.join(current, 'node_modules', packageName);
      if (isDirectory(candidate)) {
        const packageDirectory = safeRealpath(candidate);
        return resolvePackageEntry(packageDirectory, subpath);
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function readPathMapping(configFile: string): PathMapping | null {
  try {
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    if (read.error) return null;
    const host: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: () => [],
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
    };
    const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(configFile), undefined, configFile);
    const { paths, baseUrl } = parsed.options;
    const pathsBasePath = (parsed.options as { pathsBasePath?: string }).pathsBasePath;
    if (!paths && !baseUrl) return null;
    return {
      basePath: baseUrl ?? pathsBasePath ?? path.dirname(configFile),
      paths: paths ?? {},
      baseUrl,
    };
  } catch {
    return null;
  }
}

function resolvePackageEntry(packageDirectory: string, subpath: string): string | undefined {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  } catch {
  }

  if (manifest.exports !== undefined) {
    const target = resolveExportsField(manifest.exports, subpath ? `.${subpath}` : '.');
    if (target) {
      const resolved = resolveFileCandidates(path.resolve(packageDirectory, target));
      if (resolved && !isDeclarationFile(resolved)) return resolved;
    }
  }

  if (subpath) return resolveFileCandidates(path.join(packageDirectory, subpath));

  for (const field of PACKAGE_ENTRY_FIELDS) {
    const entry = manifest[field];
    if (typeof entry !== 'string') continue;
    const resolved = resolveFileCandidates(path.resolve(packageDirectory, entry));
    if (resolved && !isDeclarationFile(resolved)) return resolved;
  }
  return resolveFileCandidates(path.join(packageDirectory, 'src', 'index')) ?? resolveFileCandidates(path.join(packageDirectory, 'index'));
}

function resolveExportsField(exportsField: unknown, subpath: string): string | undefined {
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : undefined;
  if (Array.isArray(exportsField)) {
    for (const entry of exportsField) {
      const resolved = resolveExportsField(entry, subpath);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!exportsField || typeof exportsField !== 'object') return undefined;

  const record = exportsField as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.some((key) => key.startsWith('.'))) {
    return subpath === '.' ? resolveConditions(record) : undefined;
  }

  if (subpath in record) return resolveConditions(record[subpath]);
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
      return resolveConditions(record[key])?.replace(/\*/g, captured);
    }
  }
  return undefined;
}

function resolveConditions(value: unknown): string | undefined {
  if (typeof value === 'string') return isDeclarationFile(value) ? undefined : value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = resolveConditions(entry);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const condition of EXPORT_CONDITIONS) {
    if (condition in record) {
      const resolved = resolveConditions(record[condition]);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

export function resolveFileCandidates(base: string): string | undefined {
  const candidates = [base];
  for (const extension of [...ASSET_EXTENSIONS, ...SOURCE_EXTENSIONS]) candidates.push(base + extension);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));

  const extension = path.extname(base);
  const withoutExtension = base.slice(0, -extension.length);
  if (extension === '.js' || extension === '.jsx') candidates.push(`${withoutExtension}.ts`, `${withoutExtension}.tsx`);
  if (extension === '.mjs') candidates.push(`${withoutExtension}.mts`);
  if (extension === '.cjs') candidates.push(`${withoutExtension}.cts`);

  return candidates.find((candidate) => isFile(candidate));
}

function isDeclarationFile(filePath: string): boolean {
  return /\.d\.[cm]?ts$/.test(filePath);
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}
