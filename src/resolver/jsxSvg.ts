import * as ts from 'typescript';

const SUPPORTED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
  'symbol', 'use', 'title', 'desc', 'text', 'tspan',
]);

const DRAWABLE_TAGS = new Set([
  'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'use', 'text',
]);

const CAMEL_CASE_ATTRIBUTES = new Set([
  'viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits',
  'maskUnits', 'maskContentUnits', 'markerWidth', 'markerHeight', 'markerUnits',
  'refX', 'refY', 'spreadMethod', 'startOffset', 'textLength', 'lengthAdjust',
  'pathLength', 'filterUnits', 'primitiveUnits',
]);

const RENAMED_ATTRIBUTES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  xlinkHref: 'xlink:href',
  xlinkTitle: 'xlink:title',
  xmlnsXlink: 'xmlns:xlink',
  xmlSpace: 'xml:space',
  xmlLang: 'xml:lang',
};

const IGNORED_ATTRIBUTES = new Set([
  'key', 'ref', 'children', 'dangerouslySetInnerHTML', 'suppressHydrationWarning',
]);

const PAINT_ATTRIBUTES = new Set(['fill', 'stroke', 'color']);

const JSX_RUNTIME_CALL = /^_?jsx(s|DEV)?$/;
const ICON_FACTORY_CALL = /^create\w*Icon$/i;

const LUCIDE_DEFAULT_ATTRIBUTES: Array<[string, string]> = [
  ['fill', 'none'],
  ['stroke', 'currentColor'],
  ['stroke-width', '2'],
  ['stroke-linecap', 'round'],
  ['stroke-linejoin', 'round'],
];

const REACT_ICONS_DEFAULT_ATTRIBUTES: Array<[string, string]> = [
  ['fill', 'currentColor'],
  ['stroke', 'currentColor'],
  ['stroke-width', '0'],
];

const NON_VISUAL_ATTRIBUTE = /^(id|role|tabIndex|focusable|className|class|title|aria-.*|data-.*)$/;

const TEXT_ONLY_TAGS = new Set(['title', 'desc']);

const MAX_EXPANSION_DEPTH = 20;

export interface ConversionOptions {
  size: number;
  color: string;
}

export const DEFAULT_CONVERSION_OPTIONS: ConversionOptions = { size: 64, color: '#888888' };

export interface Scope {
  values: Map<string, string>;
  nodes: Map<string, ts.Expression>;
}

export type SvgConversionResult =
  | { ok: true; svgMarkup: string; warnings: string[]; originalSize?: string }
  | { ok: false; reason: string };

interface AttributeView {
  name: string;
  value: ts.Expression | string | true;
}

interface ElementView {
  tag: string;
  intrinsic: boolean;
  attributes: AttributeView[];
  children: ts.Node[];
  fromData?: boolean;
}

type ExpandedChild = { element: ElementView; scope: Scope } | { text: string };

export function createScope(): Scope {
  return { values: new Map(), nodes: new Map() };
}

export function collectFileScope(sourceFile: ts.SourceFile): Scope {
  const scope = createScope();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        addToScope(scope, declaration.name.text, declaration.initializer);
      }
    }
  }
  return scope;
}

export function convertComponentToSvg(
  componentNode: ts.Node,
  fileScope: Scope,
  options: ConversionOptions = DEFAULT_CONVERSION_OPTIONS,
): SvgConversionResult | undefined {
  const scope = createScope();
  collectComponentScope(componentNode, scope);
  for (const [name, value] of fileScope.values) if (!scope.values.has(name)) scope.values.set(name, value);
  for (const [name, node] of fileScope.nodes) if (!scope.nodes.has(name)) scope.nodes.set(name, node);

  const converter = new Converter(options);
  let markup: string;
  const root = findSvgRoot(componentNode);
  if (root) {
    markup = converter.convertRoot(root, scope);
  } else {
    const factory = findIconFactory(componentNode);
    if (!factory) return undefined;
    markup = converter.convertFactory(factory, scope);
  }

  if (!converter.hasDrawableContent) {
    return { ok: false, reason: 'The <svg> has no static shapes (its content is probably passed in at runtime).' };
  }
  return { ok: true, svgMarkup: markup, warnings: converter.warnings(), originalSize: converter.originalSize };
}

function collectComponentScope(node: ts.Node, scope: Scope): void {
  const visit = (child: ts.Node): void => {
    if ((ts.isBindingElement(child) || ts.isParameter(child)) && ts.isIdentifier(child.name) && child.initializer) {
      addToScope(scope, child.name.text, child.initializer);
    } else if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.initializer &&
      ts.isVariableDeclarationList(child.parent) &&
      (child.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      addToScope(scope, child.name.text, child.initializer);
    }
    if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) ts.forEachChild(child, visit);
  };
  visit(node);
}

function addToScope(scope: Scope, name: string, initializer: ts.Expression): void {
  if (!scope.nodes.has(name)) scope.nodes.set(name, initializer);
  const value = literalValue(initializer, scope.values);
  if (value !== undefined && !scope.values.has(name)) scope.values.set(name, value);
}

export function literalValue(expression: ts.Expression, values: Map<string, string>): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return literalValue(expression.expression, values);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return `-${expression.operand.text}`;
  }
  if (ts.isIdentifier(expression)) return values.get(expression.text);
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return values.get(`${expression.expression.text}.${expression.name.text}`);
  }
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return literalValue(expression.expression, values);
  }
  if (ts.isTemplateExpression(expression)) {
    let result = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = literalValue(span.expression, values);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return literalValue(expression.left, values) ?? literalValue(expression.right, values);
  }
  if (ts.isConditionalExpression(expression)) {
    return literalValue(expression.whenTrue, values) ?? literalValue(expression.whenFalse, values);
  }
  return undefined;
}

function findSvgRoot(node: ts.Node): ElementView | undefined {
  let found: ElementView | undefined;
  const visit = (child: ts.Node): void => {
    if (found) return;
    const element = asElement(child);
    if (element?.intrinsic && element.tag === 'svg') {
      found = element;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

interface IconFactory {
  name: string;
  call: ts.CallExpression;
}

function findIconFactory(node: ts.Node): IconFactory | undefined {
  let found: IconFactory | undefined;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const name = calleeName(child.expression);
      if (name && ICON_FACTORY_CALL.test(name)) {
        found = { name, call: child };
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

export function calleeName(expression: ts.Expression): string | undefined {
  let callee = expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) return calleeName(callee.right);
  if (ts.isIdentifier(callee)) return callee.text.replace(/^_+(?=\w)/, '');
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'default' && ts.isIdentifier(callee.expression)) {
      return callee.expression.text.replace(/^_+/, '');
    }
    return callee.name.text;
  }
  return undefined;
}

function asElement(node: ts.Node): ElementView | undefined {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const tagNode = opening.tagName;
    const tag = ts.isIdentifier(tagNode) ? tagNode.text : tagNode.getText();
    const intrinsic = ts.isIdentifier(tagNode) && /^[a-z]/.test(tag);
    const attributes: AttributeView[] = [];
    for (const property of opening.attributes.properties) {
      if (!ts.isJsxAttribute(property)) continue;
      const name = ts.isIdentifier(property.name)
        ? property.name.text
        : `${property.name.namespace.text}:${property.name.name.text}`;
      const initializer = property.initializer;
      if (!initializer) attributes.push({ name, value: true });
      else if (ts.isStringLiteral(initializer)) attributes.push({ name, value: initializer.text });
      else if (ts.isJsxExpression(initializer) && initializer.expression) attributes.push({ name, value: initializer.expression });
      else if (ts.isJsxElement(initializer) || ts.isJsxSelfClosingElement(initializer)) continue;
    }
    return { tag, intrinsic, attributes, children: ts.isJsxElement(node) ? [...node.children] : [] };
  }

  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    const [tagArgument, propsArgument, ...rest] = node.arguments;
    if (!tagArgument || (name !== 'createElement' && !(name && JSX_RUNTIME_CALL.test(name)))) return undefined;

    const intrinsic = ts.isStringLiteral(tagArgument);
    const tag = intrinsic ? tagArgument.text : `${tagArgument.getText()}`;
    const { attributes, children } = propsToAttributes(propsArgument);
    return { tag, intrinsic, attributes, children: name === 'createElement' ? [...rest] : children };
  }

  if (ts.isObjectLiteralExpression(node)) {
    const tag = objectProperty(node, 'tag');
    const attr = objectProperty(node, 'attr');
    if (!tag || !ts.isStringLiteral(tag) || (attr && !ts.isObjectLiteralExpression(attr))) return undefined;
    const child = objectProperty(node, 'child');
    return {
      tag: tag.text,
      intrinsic: true,
      attributes: propsToAttributes(attr).attributes,
      children: child ? [child] : [],
      fromData: true,
    };
  }

  if (
    ts.isArrayLiteralExpression(node) &&
    (node.elements.length === 2 || node.elements.length === 3) &&
    ts.isStringLiteral(node.elements[0]) &&
    ts.isObjectLiteralExpression(node.elements[1])
  ) {
    const { attributes } = propsToAttributes(node.elements[1]);
    const children = node.elements[2] ? [node.elements[2]] : [];
    return { tag: node.elements[0].text, intrinsic: true, attributes, children };
  }
  return undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function propsToAttributes(props: ts.Expression | undefined): { attributes: AttributeView[]; children: ts.Node[] } {
  const attributes: AttributeView[] = [];
  const children: ts.Node[] = [];
  if (!props) return { attributes, children };

  const objects: ts.ObjectLiteralExpression[] = [];
  if (ts.isObjectLiteralExpression(props)) objects.push(props);
  else if (ts.isCallExpression(props)) objects.push(...props.arguments.filter(ts.isObjectLiteralExpression));

  for (const object of objects) {
    for (const property of object.properties) {
      let name: string | undefined;
      let value: ts.Expression | undefined;
      if (ts.isPropertyAssignment(property)) {
        name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        value = property.initializer;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        name = property.name.text;
        value = property.name;
      }
      if (!name || !value) continue;
      if (name === 'children') children.push(value);
      else attributes.push({ name, value });
    }
  }
  return { attributes, children };
}

class Converter {
  hasDrawableContent = false;
  originalSize: string | undefined;
  private readonly skippedTags = new Set<string>();
  private readonly dynamicAttributes = new Set<string>();
  private skippedExpressions = 0;

  constructor(private readonly options: ConversionOptions) {}

  warnings(): string[] {
    const warnings: string[] = [];
    if (this.skippedTags.size) warnings.push(`Skipped unsupported elements: ${[...this.skippedTags].join(', ')}`);
    if (this.dynamicAttributes.size) warnings.push(`Ignored dynamic attributes: ${[...this.dynamicAttributes].join(', ')}`);
    if (this.skippedExpressions) warnings.push(`Skipped ${this.skippedExpressions} dynamic child expression(s)`);
    return warnings;
  }

  convertRoot(svg: ElementView, scope: Scope): string {
    const attributes = this.convertAttributes(svg, scope);
    if (svg.fromData) {
      for (const [name, value] of REACT_ICONS_DEFAULT_ATTRIBUTES) if (!attributes.has(name)) attributes.set(name, value);
    }
    return this.finishRoot(attributes, this.convertChildren(svg.children, scope, 0));
  }

  convertFactory(factory: IconFactory, scope: Scope): string {
    const isLucide = /lucide/i.test(factory.name);
    const attributes = new Map<string, string>(isLucide ? LUCIDE_DEFAULT_ATTRIBUTES : [['fill', 'currentColor']]);
    let viewBox = '0 0 24 24';
    const shapes: ExpandedChild[] = [];

    for (const argument of factory.call.arguments) {
      if (ts.isObjectLiteralExpression(argument) && !asElement(argument)) {
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          const key = property.name.text;
          if (key === 'viewBox') viewBox = literalValue(property.initializer, scope.values) ?? viewBox;
          else if (key === 'path') shapes.push(...this.expand(property.initializer, scope, 0));
          else if (key === 'd') {
            const d = literalValue(property.initializer, scope.values);
            if (d) {
              this.hasDrawableContent = true;
              shapes.push({ text: `<path d="${escapeAttribute(d)}"/>` });
            }
          }
        }
        continue;
      }
      shapes.push(...this.expand(argument, scope, 0).filter((child) => 'element' in child));
    }

    attributes.set('viewBox', viewBox);
    const children = shapes
      .map((child) => ('element' in child ? this.convertElement(child.element, child.scope) : child.text))
      .join('');
    return this.finishRoot(attributes, children);
  }

  private finishRoot(attributes: Map<string, string>, children: string): string {
    attributes.set('xmlns', 'http://www.w3.org/2000/svg');
    if (children.includes('xlink:') || [...attributes.keys()].some((name) => name.startsWith('xlink:'))) {
      attributes.set('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }
    this.normalizePreviewSize(attributes);
    if (!attributes.has('color')) attributes.set('color', this.options.color);
    return render('svg', attributes, children);
  }

  private normalizePreviewSize(attributes: Map<string, string>): void {
    const width = parseFloat(attributes.get('width') ?? '');
    const height = parseFloat(attributes.get('height') ?? '');
    if (!attributes.has('viewBox') && width > 0 && height > 0) {
      attributes.set('viewBox', `0 0 ${width} ${height}`);
    }

    let aspect = 1;
    const viewBox = attributes.get('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (width > 0 && height > 0) {
      this.originalSize = `${width}×${height}`;
      aspect = width / height;
    } else if (viewBox && viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      this.originalSize = `${viewBox[2]}×${viewBox[3]} viewBox`;
      aspect = viewBox[2] / viewBox[3];
    }

    const size = this.options.size;
    attributes.set('width', String(aspect >= 1 ? size : Math.round(size * aspect)));
    attributes.set('height', String(aspect >= 1 ? Math.round(size / aspect) : size));
  }

  private convertElement(element: ElementView, scope: Scope): string {
    if (!element.intrinsic || !SUPPORTED_TAGS.has(element.tag)) {
      this.skippedTags.add(`<${element.tag}>`);
      return '';
    }
    if (TEXT_ONLY_TAGS.has(element.tag)) {
      const skippedBefore = this.skippedExpressions;
      const dynamicBefore = new Set(this.dynamicAttributes);
      const children = this.convertChildren(element.children, scope, 0);
      const attributes = this.convertAttributes(element, scope);
      if (!children) {
        this.skippedExpressions = skippedBefore;
        this.dynamicAttributes.clear();
        for (const name of dynamicBefore) this.dynamicAttributes.add(name);
        return '';
      }
      return render(element.tag, attributes, children);
    }
    if (DRAWABLE_TAGS.has(element.tag)) this.hasDrawableContent = true;
    return render(element.tag, this.convertAttributes(element, scope), this.convertChildren(element.children, scope, 0));
  }

  private convertChildren(children: ts.Node[], scope: Scope, depth: number): string {
    return children
      .flatMap((child) => this.expand(child, scope, depth))
      .map((child) => ('element' in child ? this.convertElement(child.element, child.scope) : escapeText(child.text)))
      .join('');
  }

  private expand(node: ts.Node, scope: Scope, depth: number): ExpandedChild[] {
    if (depth > MAX_EXPANSION_DEPTH) return [];

    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      return text ? [{ text }] : [];
    }
    if (ts.isJsxExpression(node)) return node.expression ? this.expand(node.expression, scope, depth) : [];
    if (ts.isJsxFragment(node)) return node.children.flatMap((child) => this.expand(child, scope, depth + 1));
    if (!ts.isExpression(node)) return [];

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return this.expand(node.expression, scope, depth + 1);
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.TrueKeyword) {
      return [];
    }

    const element = asElement(node);
    if (element) return [{ element, scope }];

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return this.expand(node.right, scope, depth + 1);
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.expand(node.whenTrue, scope, depth + 1);
      return whenTrue.length ? whenTrue : this.expand(node.whenFalse, scope, depth + 1);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((child) => this.expand(child, scope, depth + 1));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
      const mapped = this.expandMap(node, scope, depth);
      if (mapped) return mapped;
    }

    const value = literalValue(node, scope.values);
    if (value !== undefined) return [{ text: value }];

    if (ts.isIdentifier(node)) {
      const initializer = scope.nodes.get(node.text);
      if (initializer) return this.expand(initializer, scope, depth + 1);
    }

    this.skippedExpressions++;
    return [];
  }

  private expandMap(call: ts.CallExpression, scope: Scope, depth: number): ExpandedChild[] | undefined {
    const receiverExpression = (call.expression as ts.PropertyAccessExpression).expression;
    const receiver = ts.isIdentifier(receiverExpression) ? scope.nodes.get(receiverExpression.text) : receiverExpression;
    const callback = call.arguments[0];
    if (!receiver || !ts.isArrayLiteralExpression(receiver)) return undefined;
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return undefined;

    const body = callbackResult(callback);
    if (!body) return undefined;
    const [itemParameter, indexParameter] = callback.parameters;

    const results: ExpandedChild[] = [];
    receiver.elements.forEach((item, index) => {
      const itemScope: Scope = { values: new Map(scope.values), nodes: scope.nodes };
      if (itemParameter) bindParameter(itemParameter.name, item, itemScope);
      if (indexParameter && ts.isIdentifier(indexParameter.name)) itemScope.values.set(indexParameter.name.text, String(index));
      results.push(...this.expand(body, itemScope, depth + 1));
    });
    return results;
  }

  private convertAttributes(element: ElementView, scope: Scope): Map<string, string> {
    const attributes = new Map<string, string>();
    for (const attribute of element.attributes) {
      if (IGNORED_ATTRIBUTES.has(attribute.name) || /^on[A-Z]/.test(attribute.name)) continue;

      const svgName = toSvgAttributeName(attribute.name);
      const value = attributeValue(svgName, attribute.value, scope);
      if (value === undefined) {
        if (PAINT_ATTRIBUTES.has(svgName)) attributes.set(svgName, 'currentColor');
        else if (!NON_VISUAL_ATTRIBUTE.test(attribute.name)) this.dynamicAttributes.add(attribute.name);
        continue;
      }
      attributes.set(svgName, value);
    }
    return attributes;
  }
}

function callbackResult(callback: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | undefined {
  if (!ts.isBlock(callback.body)) return callback.body;
  const returnStatement = callback.body.statements.find(ts.isReturnStatement);
  return returnStatement?.expression;
}

function bindParameter(name: ts.BindingName, item: ts.Expression, scope: Scope): void {
  if (ts.isIdentifier(name)) {
    const value = literalValue(item, scope.values);
    if (value !== undefined) scope.values.set(name.text, value);
    if (ts.isObjectLiteralExpression(item)) {
      for (const [key, propertyValue] of objectLiteralValues(item, scope)) scope.values.set(`${name.text}.${key}`, propertyValue);
    }
    return;
  }
  if (ts.isObjectBindingPattern(name) && ts.isObjectLiteralExpression(item)) {
    const properties = objectLiteralValues(item, scope);
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const key = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
      const value = properties.get(key) ?? (element.initializer ? literalValue(element.initializer, scope.values) : undefined);
      if (value !== undefined) scope.values.set(element.name.text, value);
    }
  }
}

function objectLiteralValues(object: ts.ObjectLiteralExpression, scope: Scope): Map<string, string> {
  const values = new Map<string, string>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    const value = literalValue(property.initializer, scope.values);
    if (key && value !== undefined) values.set(key, value);
  }
  return values;
}

function attributeValue(svgName: string, value: AttributeView['value'], scope: Scope): string | undefined {
  if (value === true) return 'true';
  if (typeof value === 'string') return value;
  if (svgName === 'style' && ts.isObjectLiteralExpression(value)) {
    const declarations = [...objectLiteralValues(value, scope)].map(([key, v]) => `${camelToKebab(key)}:${v}`);
    return declarations.length ? declarations.join(';') : undefined;
  }
  return literalValue(value, scope.values);
}

function render(name: string, attributes: Map<string, string>, children: string): string {
  const attributeText = [...attributes].map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('');
  return children ? `<${name}${attributeText}>${children}</${name}>` : `<${name}${attributeText}/>`;
}

export function toSvgAttributeName(jsxName: string): string {
  if (RENAMED_ATTRIBUTES[jsxName]) return RENAMED_ATTRIBUTES[jsxName];
  if (CAMEL_CASE_ATTRIBUTES.has(jsxName) || jsxName.includes(':') || jsxName.includes('-')) return jsxName;
  return camelToKebab(jsxName);
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
