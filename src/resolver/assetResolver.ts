import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import {
  ASSET_EXTENSIONS,
  SOURCE_EXTENSIONS,
  OffsetRange,
  ResolvedAsset,
  ResolvedPreview,
} from '../types';
import {
  ConversionOptions,
  DEFAULT_CONVERSION_OPTIONS,
  calleeName,
  collectFileScope,
  convertComponentToSvg,
} from './jsxSvg';
import { ModuleResolver, resolveFileCandidates } from './moduleResolver';
import { extractScriptBlocks, extractTemplateSvg, kebabToPascal, pathLiteralAt, wordAt } from './textScan';

const MAX_DEPTH = 32;

const WRAPPER_CALL = /^(memo|forwardRef|observer|with[A-Z]\w*)$/;
const SINGLE_FILE_COMPONENT_EXTENSIONS = new Set(['.vue', '.svelte']);
const PUBLIC_DIRECTORIES = ['public', 'static', ''];

type Target =
  | { kind: 'asset'; assetPath: string }
  | { kind: 'component'; filePath: string; sourceFile: ts.SourceFile; node: ts.Node }
  | { kind: 'namespace'; modulePath: string };

interface ImportInfo {
  moduleSpecifier: string;
  importedName: string;
}

interface CachedSource {
  mtimeMs: number;
  sourceFile: ts.SourceFile;
}

export interface AssetResolverOptions {
  readFile?: (filePath: string) => string | undefined;
}

export class AssetResolver {
  private readonly cache = new Map<string, CachedSource>();
  private readonly modules = new ModuleResolver();

  constructor(private readonly options: AssetResolverOptions = {}) {}

  clearCaches(): void {
    this.cache.clear();
    this.modules.clearCache();
  }

  resolveExportAtPosition(filePath: string, text: string, offset: number): ResolvedAsset | undefined {
    const preview = this.resolvePreviewAtPosition(filePath, text, offset);
    return preview?.kind === 'asset' ? { assetPath: preview.assetPath, exportName: preview.exportName } : undefined;
  }

  resolvePreviewAtPosition(
    filePath: string,
    text: string,
    offset: number,
    conversion: ConversionOptions = DEFAULT_CONVERSION_OPTIONS,
  ): ResolvedPreview | undefined {
    const normalizedFile = path.resolve(filePath);
    const extension = path.extname(normalizedFile).toLowerCase();

    if (SOURCE_EXTENSIONS.includes(extension)) {
      return this.resolveInScript(normalizedFile, text, offset, scriptKind(normalizedFile), conversion);
    }
    if (SINGLE_FILE_COMPONENT_EXTENSIONS.has(extension)) {
      return this.resolveInSingleFileComponent(normalizedFile, text, offset, conversion);
    }
    return this.resolvePathLiteralAt(normalizedFile, text, offset);
  }

  private resolveInScript(
    filePath: string,
    text: string,
    offset: number,
    kind: ts.ScriptKind,
    conversion: ConversionOptions,
  ): ResolvedPreview | undefined {
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
    const token = findTokenAtOffset(sourceFile, offset);
    if (!token) return undefined;

    if (ts.isStringLiteral(token) || ts.isNoSubstitutionTemplateLiteral(token)) {
      const start = token.getStart(sourceFile) + 1;
      return this.previewForPathString(filePath, token.text, { start, end: start + token.text.length });
    }

    const range: OffsetRange = { start: token.getStart(sourceFile), end: token.getEnd() };
    const target = this.resolveIdentifier(filePath, sourceFile, token);
    return this.toPreview(target, token.text, range, conversion);
  }

  private resolveInSingleFileComponent(
    filePath: string,
    text: string,
    offset: number,
    conversion: ConversionOptions,
  ): ResolvedPreview | undefined {
    const blocks = extractScriptBlocks(text);
    const kind = blocks.usesJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    if (blocks.regions.some((region) => offset >= region.start && offset <= region.end)) {
      return this.resolveInScript(filePath, blocks.maskedText, offset, kind, conversion);
    }

    const literal = this.resolvePathLiteralAt(filePath, text, offset);
    if (literal) return literal;

    const word = wordAt(text, offset);
    if (!word) return undefined;
    const sourceFile = ts.createSourceFile(filePath, blocks.maskedText, ts.ScriptTarget.Latest, true, kind);
    const range: OffsetRange = { start: word.start, end: word.end };
    for (const name of new Set([word.value, kebabToPascal(word.value)])) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const target = this.resolveLocalName(filePath, sourceFile, name, new Set(), 0);
      const preview = this.toPreview(target, name, range, conversion);
      if (preview) return preview;
    }
    return undefined;
  }

  private resolvePathLiteralAt(filePath: string, text: string, offset: number): ResolvedPreview | undefined {
    const literal = pathLiteralAt(text, offset);
    return literal ? this.previewForPathString(filePath, literal.value, literal) : undefined;
  }

  private previewForPathString(filePath: string, value: string, range: OffsetRange): ResolvedPreview | undefined {
    const assetPath = this.resolveAssetString(filePath, value);
    return assetPath ? { kind: 'asset', exportName: path.basename(assetPath), assetPath, range } : undefined;
  }

  resolveAssetString(fromFile: string, value: string): string | undefined {
    const cleaned = value.trim().replace(/[?#].*$/, '');
    if (!cleaned || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return undefined;
    if (!isAssetPath(cleaned)) return undefined;

    if (cleaned.startsWith('/')) {
      const projectRoot = findProjectRoot(path.dirname(fromFile));
      if (projectRoot) {
        for (const directory of PUBLIC_DIRECTORIES) {
          const candidate = path.join(projectRoot, directory, cleaned);
          if (isFile(candidate)) return candidate;
        }
      }
      return isFile(cleaned) ? cleaned : undefined;
    }

    const specifier = cleaned.startsWith('~') ? cleaned.slice(1).replace(/^\//, '') : cleaned;
    const resolved = this.modules.resolve(fromFile, specifier)
      ?? (!specifier.startsWith('.') ? resolveFileCandidates(path.resolve(path.dirname(fromFile), specifier)) : undefined);
    return resolved && isAssetPath(resolved) ? resolved : undefined;
  }

  private toPreview(
    target: Target | undefined,
    exportName: string,
    range: OffsetRange,
    conversion: ConversionOptions,
  ): ResolvedPreview | undefined {
    if (!target || target.kind === 'namespace') return undefined;
    if (target.kind === 'asset') return { kind: 'asset', exportName, assetPath: target.assetPath, range };

    try {
      const result = convertComponentToSvg(target.node, collectFileScope(target.sourceFile), conversion);
      if (!result) return undefined;
      if (!result.ok) return { kind: 'unsupported', exportName, sourcePath: target.filePath, reason: result.reason, range };
      return {
        kind: 'jsx-svg',
        exportName,
        sourcePath: target.filePath,
        svgMarkup: result.svgMarkup,
        warnings: result.warnings,
        originalSize: result.originalSize,
        range,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: 'unsupported', exportName, sourcePath: target.filePath, reason: `Could not convert JSX: ${reason}`, range };
    }
  }

  private resolveIdentifier(filePath: string, sourceFile: ts.SourceFile, identifier: ts.Identifier): Target | undefined {
    const parent = identifier.parent;
    const visited = new Set<string>();

    if (ts.isExportSpecifier(parent)) {
      if (parent.name !== identifier) return undefined;
      return this.resolveExportInSourceFile(filePath, sourceFile, identifier.text, visited, 0);
    }

    if (ts.isImportSpecifier(parent)) {
      const declaration = parent.parent.parent.parent;
      if (!ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
      const importedName = parent.propertyName?.text ?? parent.name.text;
      return this.resolveImport(filePath, { moduleSpecifier: declaration.moduleSpecifier.text, importedName }, visited, 0);
    }

    if (ts.isImportClause(parent)) {
      const declaration = parent.parent;
      if (!ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
      return this.resolveImport(filePath, { moduleSpecifier: declaration.moduleSpecifier.text, importedName: 'default' }, visited, 0);
    }

    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
      return this.resolveExpression(filePath, sourceFile, parent, visited, 0);
    }

    if (ts.isNamespaceImport(parent)) return undefined;
    if (ts.isQualifiedName(parent) && parent.right === identifier) return undefined;
    if (ts.isPropertyAssignment(parent) && parent.name === identifier) return undefined;
    if (ts.isJsxAttribute(parent)) return undefined;

    return this.resolveLocalName(filePath, sourceFile, identifier.text, visited, 0);
  }

  private resolveImport(fromFile: string, info: ImportInfo, visited: Set<string>, depth: number): Target | undefined {
    const modulePath = this.modules.resolve(fromFile, info.moduleSpecifier);
    if (!modulePath) return undefined;
    if (isAssetPath(modulePath)) return { kind: 'asset', assetPath: modulePath };
    if (info.importedName === '*') return { kind: 'namespace', modulePath };
    return this.resolveExportInFile(modulePath, info.importedName, visited, depth + 1);
  }

  private resolveExportInFile(filePath: string, exportName: string, visited: Set<string>, depth: number): Target | undefined {
    if (isAssetPath(filePath)) return { kind: 'asset', assetPath: filePath };

    const extension = path.extname(filePath).toLowerCase();
    if (SINGLE_FILE_COMPONENT_EXTENSIONS.has(extension)) {
      if (exportName !== 'default') return undefined;
      const sourceFile = this.parseTemplateSvg(filePath);
      return sourceFile ? { kind: 'component', filePath, sourceFile, node: sourceFile } : undefined;
    }

    const sourceFile = this.parseFile(filePath);
    if (!sourceFile) return undefined;
    return this.resolveExportInSourceFile(filePath, sourceFile, exportName, visited, depth);
  }

  private resolveExportInSourceFile(
    filePath: string,
    sourceFile: ts.SourceFile,
    exportName: string,
    visited: Set<string>,
    depth: number,
  ): Target | undefined {
    const visitKey = `export:${filePath}::${exportName}`;
    if (depth > MAX_DEPTH || visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        const result = this.resolveExportDeclaration(filePath, sourceFile, statement, exportName, visited, depth);
        if (result) return result;
        continue;
      }

      if (ts.isExportAssignment(statement) && !statement.isExportEquals && exportName === 'default') {
        const result = this.resolveExpression(filePath, sourceFile, statement.expression, visited, depth);
        if (result) return result;
        continue;
      }

      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if ((isDefault && exportName === 'default') || (!isDefault && statement.name?.text === exportName)) {
          return { kind: 'component', filePath, sourceFile, node: statement };
        }
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName || !declaration.initializer) continue;
          return this.resolveExpression(filePath, sourceFile, declaration.initializer, visited, depth);
        }
      }
    }

    return this.resolveCommonJsExport(filePath, sourceFile, exportName, visited, depth);
  }

  private resolveExportDeclaration(
    filePath: string,
    sourceFile: ts.SourceFile,
    statement: ts.ExportDeclaration,
    exportName: string,
    visited: Set<string>,
    depth: number,
  ): Target | undefined {
    const clause = statement.exportClause;

    if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifierText = statement.moduleSpecifier.text;

      if (clause && ts.isNamespaceExport(clause)) {
        if (clause.name.text !== exportName) return undefined;
        const modulePath = this.modules.resolve(filePath, specifierText);
        return modulePath ? { kind: 'namespace', modulePath } : undefined;
      }

      if (clause && ts.isNamedExports(clause)) {
        const specifier = clause.elements.find((element) => element.name.text === exportName);
        if (!specifier) return undefined;
        const importedName = specifier.propertyName?.text ?? exportName;
        return this.resolveImport(filePath, { moduleSpecifier: specifierText, importedName }, visited, depth);
      }

      if (!clause && exportName !== 'default') {
        const modulePath = this.modules.resolve(filePath, specifierText);
        if (!modulePath || isAssetPath(modulePath)) return undefined;
        return this.resolveExportInFile(modulePath, exportName, visited, depth + 1);
      }
      return undefined;
    }

    if (clause && ts.isNamedExports(clause)) {
      const specifier = clause.elements.find((element) => element.name.text === exportName);
      if (!specifier) return undefined;
      const localName = specifier.propertyName?.text ?? exportName;
      return this.resolveLocalName(filePath, sourceFile, localName, visited, depth);
    }
    return undefined;
  }

  private resolveCommonJsExport(
    filePath: string,
    sourceFile: ts.SourceFile,
    exportName: string,
    visited: Set<string>,
    depth: number,
  ): Target | undefined {
    for (const statement of sourceFile.statements) {
      const expressions: ts.Expression[] = [];
      if (ts.isExpressionStatement(statement)) expressions.push(statement.expression);
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer) expressions.push(declaration.initializer);
        }
      }

      for (const expression of expressions) {
        if (ts.isCallExpression(expression)) {
          const result = this.resolveCommonJsCall(filePath, sourceFile, expression, exportName, visited, depth);
          if (result) return result;
          continue;
        }

        const names: string[] = [];
        let value: ts.Expression = expression;
        while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const name = commonJsExportName(value.left);
          if (name) names.push(name);
          value = value.right;
        }
        if (ts.isVoidExpression(value) || (ts.isIdentifier(value) && value.text === 'undefined')) continue;
        if (names.includes(exportName)) return this.resolveExpression(filePath, sourceFile, value, visited, depth);
        if (!names.includes('module.exports')) continue;

        if (exportName === 'default') return this.resolveExpression(filePath, sourceFile, value, visited, depth);
        if (ts.isObjectLiteralExpression(value)) {
          const property = value.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === exportName);
          if (property && ts.isPropertyAssignment(property)) {
            return this.resolveExpression(filePath, sourceFile, property.initializer, visited, depth);
          }
          if (property && ts.isShorthandPropertyAssignment(property)) {
            return this.resolveLocalName(filePath, sourceFile, exportName, visited, depth);
          }
        }
        const moduleTarget = this.resolveExpression(filePath, sourceFile, value, visited, depth);
        if (moduleTarget?.kind === 'namespace') return this.resolveExportInFile(moduleTarget.modulePath, exportName, visited, depth + 1);
      }
    }
    return undefined;
  }

  private resolveCommonJsCall(
    filePath: string,
    sourceFile: ts.SourceFile,
    call: ts.CallExpression,
    exportName: string,
    visited: Set<string>,
    depth: number,
  ): Target | undefined {
    const name = calleeName(call.expression);
    const [first, second, third] = call.arguments;

    if (
      name === 'defineProperty' && first && ts.isIdentifier(first) && first.text === 'exports' &&
      second && ts.isStringLiteral(second) && second.text === exportName &&
      third && ts.isObjectLiteralExpression(third)
    ) {
      for (const property of third.properties) {
        const key = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
        if (key === 'value' && ts.isPropertyAssignment(property)) {
          return this.resolveExpression(filePath, sourceFile, property.initializer, visited, depth);
        }
        if (key !== 'get') continue;
        const getter = ts.isPropertyAssignment(property) ? property.initializer : property;
        if (ts.isFunctionExpression(getter) || ts.isArrowFunction(getter) || ts.isMethodDeclaration(getter) || ts.isGetAccessor(getter)) {
          const returned = functionResult(getter);
          if (returned) return this.resolveExpression(filePath, sourceFile, returned, visited, depth);
        }
      }
      return undefined;
    }

    if (exportName === 'default') return undefined;

    let reExported: ts.Expression | undefined;
    if ((name === 'exportStar' || name === '__exportStar' || name === 'export' || name === '__export') && first) reExported = first;
    if (
      name === 'forEach' && ts.isPropertyAccessExpression(call.expression) &&
      ts.isCallExpression(call.expression.expression) && calleeName(call.expression.expression.expression) === 'keys'
    ) {
      reExported = call.expression.expression.arguments[0];
    }
    if (!reExported) return undefined;
    const moduleTarget = this.resolveExpression(filePath, sourceFile, reExported, visited, depth);
    return moduleTarget?.kind === 'namespace'
      ? this.resolveExportInFile(moduleTarget.modulePath, exportName, visited, depth + 1)
      : undefined;
  }

  private resolveLocalName(
    filePath: string,
    sourceFile: ts.SourceFile,
    localName: string,
    visited: Set<string>,
    depth: number,
  ): Target | undefined {
    const visitKey = `local:${filePath}::${localName}`;
    if (depth > MAX_DEPTH || visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    const importInfo = findImportForLocalName(sourceFile, localName);
    if (importInfo) return this.resolveImport(filePath, importInfo, visited, depth);

    for (const statement of sourceFile.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === localName) {
        return { kind: 'component', filePath, sourceFile, node: statement };
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== localName || !declaration.initializer) continue;
          return this.resolveExpression(filePath, sourceFile, declaration.initializer, visited, depth);
        }
      }
    }
    return undefined;
  }

  private resolveExpression(
    filePath: string,
    sourceFile: ts.SourceFile,
    expression: ts.Expression,
    visited: Set<string>,
    depth: number,
  ): Target | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const next = depth + 1;

    if (
      ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression) || ts.isTypeAssertionExpression(expression)
    ) {
      return this.resolveExpression(filePath, sourceFile, expression.expression, visited, next);
    }

    if (ts.isIdentifier(expression)) return this.resolveLocalName(filePath, sourceFile, expression.text, visited, next);

    if (ts.isPropertyAccessExpression(expression)) {
      const object = this.resolveExpression(filePath, sourceFile, expression.expression, visited, next);
      if (!object) return undefined;
      if (object.kind === 'asset') return object;
      if (object.kind === 'namespace') return this.resolveExportInFile(object.modulePath, expression.name.text, visited, next);
      if (ts.isObjectLiteralExpression(object.node)) {
        const property = object.node.properties.find(
          (p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === expression.name.text,
        );
        if (property && ts.isPropertyAssignment(property)) {
          return this.resolveExpression(object.filePath, object.sourceFile, property.initializer, visited, next);
        }
        if (property && ts.isShorthandPropertyAssignment(property)) {
          return this.resolveLocalName(object.filePath, object.sourceFile, property.name.text, visited, next);
        }
      }
      return undefined;
    }

    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'URL') {
      const [first] = expression.arguments ?? [];
      const assetPath = first && ts.isStringLiteral(first) ? this.resolveAssetString(filePath, first.text) : undefined;
      return assetPath ? { kind: 'asset', assetPath } : undefined;
    }

    if (ts.isCallExpression(expression)) {
      const name = calleeName(expression.expression);
      const [first] = expression.arguments;

      if (ts.isIdentifier(expression.expression) && expression.expression.text === 'require') {
        if (!first || !ts.isStringLiteral(first)) return undefined;
        const modulePath = this.modules.resolve(filePath, first.text);
        if (!modulePath) return undefined;
        return isAssetPath(modulePath) ? { kind: 'asset', assetPath: modulePath } : { kind: 'namespace', modulePath };
      }

      if (name && WRAPPER_CALL.test(name) && first && !ts.isFunctionLike(first)) {
        return this.resolveExpression(filePath, sourceFile, first, visited, next);
      }

      if (
        first && expression.arguments.length === 1 && ts.isCallExpression(first) &&
        ts.isIdentifier(first.expression) && first.expression.text === 'require'
      ) {
        return this.resolveExpression(filePath, sourceFile, first, visited, next);
      }
    }

    return { kind: 'component', filePath, sourceFile, node: expression };
  }

  private parseFile(filePath: string): ts.SourceFile | undefined {
    try {
      const override = this.options.readFile?.(filePath);
      if (override !== undefined) {
        return ts.createSourceFile(filePath, override, ts.ScriptTarget.Latest, true, scriptKind(filePath));
      }

      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return undefined;
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.sourceFile;

      const text = fs.readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
      this.cache.set(filePath, { mtimeMs: stat.mtimeMs, sourceFile });
      return sourceFile;
    } catch {
      return undefined;
    }
  }

  private parseTemplateSvg(filePath: string): ts.SourceFile | undefined {
    try {
      const text = this.options.readFile?.(filePath) ?? fs.readFileSync(filePath, 'utf8');
      const svg = extractTemplateSvg(text);
      if (!svg) return undefined;
      return ts.createSourceFile(`${filePath}.tsx`, `const template = (${svg});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    } catch {
      return undefined;
    }
  }
}

function findTokenAtOffset(
  sourceFile: ts.SourceFile,
  offset: number,
): ts.Identifier | ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | undefined {
  let found: ts.Identifier | ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(sourceFile) || offset > node.getEnd()) return;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findImportForLocalName(sourceFile: ts.SourceFile, localName: string): ImportInfo | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (clause.name?.text === localName) return { moduleSpecifier, importedName: 'default' };

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName) {
      return { moduleSpecifier, importedName: '*' };
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.name.text === localName) {
          return { moduleSpecifier, importedName: element.propertyName?.text ?? element.name.text };
        }
      }
    }
  }
  return undefined;
}

function commonJsExportName(expression: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const object = expression.expression;
  if (ts.isIdentifier(object) && object.text === 'module' && expression.name.text === 'exports') return 'module.exports';
  if (ts.isIdentifier(object) && object.text === 'exports') return expression.name.text;
  if (
    ts.isPropertyAccessExpression(object) && ts.isIdentifier(object.expression) &&
    object.expression.text === 'module' && object.name.text === 'exports'
  ) {
    return expression.name.text;
  }
  return undefined;
}

function functionResult(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  if (!fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;
  return fn.body.statements.find(ts.isReturnStatement)?.expression;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isAssetPath(filePath: string): boolean {
  return ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findProjectRoot(directory: string): string | undefined {
  let current = directory;
  while (true) {
    if (isFile(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}
