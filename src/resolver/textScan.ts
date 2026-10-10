export interface TextSpan {
  value: string;
  start: number;
  end: number;
}

export function pathLiteralAt(text: string, offset: number): TextSpan | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const newline = text.indexOf('\n', offset);
  const lineEnd = newline === -1 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);

  const pattern = /"([^"]*)"|'([^']*)'|`([^`$]*)`|url\(\s*([^"'\s)][^\s)]*)\s*\)/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const start = lineStart + match.index + match[0].indexOf(value, match[4] !== undefined ? 4 : 1);
    const end = start + value.length;
    if (offset >= start && offset <= end && value) return { value, start, end };
  }
  return undefined;
}

export function wordAt(text: string, offset: number): TextSpan | undefined {
  const isWordCharacter = (character: string | undefined) => !!character && /[\w$-]/.test(character);
  let start = offset;
  let end = offset;
  while (start > 0 && isWordCharacter(text[start - 1])) start--;
  while (end < text.length && isWordCharacter(text[end])) end++;
  return end > start ? { value: text.slice(start, end), start, end } : undefined;
}

export interface ScriptBlocks {
  maskedText: string;
  regions: Array<{ start: number; end: number }>;
  usesJsx: boolean;
}

export function extractScriptBlocks(text: string): ScriptBlocks {
  const regions: Array<{ start: number; end: number }> = [];
  let usesJsx = false;
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + match[0].indexOf('>') + 1;
    regions.push({ start, end: start + match[2].length });
    if (/\blang\s*=\s*["']?(tsx|jsx)/i.test(match[1])) usesJsx = true;
  }

  let maskedText = '';
  let cursor = 0;
  for (const region of regions) {
    maskedText += text.slice(cursor, region.start).replace(/[^\n]/g, ' ') + text.slice(region.start, region.end);
    cursor = region.end;
  }
  maskedText += text.slice(cursor).replace(/[^\n]/g, ' ');
  return { maskedText, regions, usesJsx };
}

export function extractTemplateSvg(text: string): string | undefined {
  const withoutScripts = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const match = /<svg\b[\s\S]*?<\/svg>/i.exec(withoutScripts);
  if (!match) return undefined;
  return match[0]
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(?::|@|#|v-|bind:|on:|use:|class:|transition:)[\w.:\-[\]]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/\{[#:/@][^}]*\}/g, '');
}

export function kebabToPascal(value: string): string {
  return value.replace(/(^|-)([a-z0-9])/g, (_match, _dash, letter: string) => letter.toUpperCase());
}
