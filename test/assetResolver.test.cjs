const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssetResolver } = require('../out/resolver/assetResolver.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-export-preview-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'barrels', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg></svg>');
  fs.writeFileSync(path.join(root, 'assets', 'avatar.png'), 'fake-png');
  fs.writeFileSync(path.join(root, 'barrels', 'nested', 'index.ts'), "export { default as Logo } from '../../assets/logo.svg';\n");
  fs.writeFileSync(path.join(root, 'barrels', 'index.ts'), "export { Logo } from './nested';\n");
  return root;
}

function hoverAt(resolver, filePath, text, needle) {
  const offset = text.indexOf(needle) + Math.floor(needle.length / 2);
  return resolver.resolveExportAtPosition(filePath, text, offset);
}

test('resolves a direct named asset export', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'assets', 'index.ts');
  const text = "export { default as Logo } from './logo.svg';";
  fs.writeFileSync(file, text);
  assert.equal(hoverAt(new AssetResolver(), file, text, 'Logo').assetPath, path.join(root, 'assets', 'logo.svg'));
});

test('follows a nested barrel re-export', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'barrels', 'index.ts');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(hoverAt(new AssetResolver(), file, text, 'Logo').assetPath, path.join(root, 'assets', 'logo.svg'));
});

test('resolves local import followed by export', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'assets', 'index.ts');
  const text = "import Logo from './logo.svg';\nexport { Logo };";
  fs.writeFileSync(file, text);
  assert.equal(hoverAt(new AssetResolver(), file, text, 'Logo').assetPath, path.join(root, 'assets', 'logo.svg'));
});

test('does not preview when hovering over a non-exported part of the line', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'assets', 'index.ts');
  const text = "export { default as Logo } from './logo.svg';";
  fs.writeFileSync(file, text);
  const offset = text.indexOf('default') + 2;
  assert.equal(new AssetResolver().resolveExportAtPosition(file, text, offset), undefined);
});

test('returns undefined for missing assets', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'assets', 'index.ts');
  const text = "export { default as Missing } from './missing.svg';";
  fs.writeFileSync(file, text);
  assert.equal(hoverAt(new AssetResolver(), file, text, 'Missing'), undefined);
});

function previewAt(filePath, text, needle, occurrence = 0) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(needle, index + 1);
  return new AssetResolver().resolvePreviewAtPosition(filePath, text, index + Math.floor(needle.length / 2));
}

function jsxFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-export-preview-jsx-'));
  const icons = path.join(root, 'icons');
  fs.mkdirSync(path.join(icons, 'arrows'), { recursive: true });
  fs.writeFileSync(path.join(icons, 'arrows', 'ChevronDownIcon.tsx'), `
import React from 'react';
export const ChevronDownIcon = ({ size = 24, color, ...props }: Props) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="icon" onClick={props.onClick} {...props}>
    <g strokeLinecap="round">
      <path d="M6 9l6 6 6-6" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <circle cx="12" cy="12" r={1.5} />
      <Tooltip label="x" />
    </g>
  </svg>
);
`);
  fs.writeFileSync(path.join(icons, 'arrows', 'index.ts'), "export { ChevronDownIcon } from './ChevronDownIcon';\n");
  fs.writeFileSync(path.join(icons, 'Star.jsx'), `
const Star = React.forwardRef(function Star(props, ref) {
  return <svg viewBox="0 0 10 10" ref={ref}><polygon points="5,0 6,4 10,4" /><rect x="1" y="1" width="2" height="2" /><line x1="0" y1="0" x2="1" y2="1" /></svg>;
});
export default Star;
`);
  fs.writeFileSync(path.join(icons, 'Empty.tsx'), 'export function Empty({ children }) { return <svg viewBox="0 0 1 1">{children}</svg>; }\n');
  fs.writeFileSync(path.join(icons, 'Button.tsx'), 'export const Button = () => <button>hi</button>;\n');
  fs.writeFileSync(path.join(icons, 'index.ts'), [
    "export * from './arrows';",
    "export { default as StarIcon } from './Star';",
    "export { Empty } from './Empty';",
    "export { Button } from './Button';",
    "export { Loop } from './loop-a';",
  ].join('\n'));
  fs.writeFileSync(path.join(icons, 'loop-a.ts'), "export { Loop } from './loop-b';\n");
  fs.writeFileSync(path.join(icons, 'loop-b.ts'), "export { Loop } from './loop-a';\n");
  return root;
}

test('previews a named JSX SVG import through nested barrels', (t) => {
  const root = jsxFixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'App.tsx');
  const text = "import { ChevronDownIcon } from './icons';\nexport const App = () => <ChevronDownIcon />;";
  const preview = previewAt(file, text, 'ChevronDownIcon');
  assert.equal(preview.kind, 'jsx-svg');
  assert.equal(preview.sourcePath, path.join(root, 'icons', 'arrows', 'ChevronDownIcon.tsx'));
  const svg = preview.svgMarkup;
  assert.match(svg, /^<svg /);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /class="icon"/);
  assert.match(svg, /stroke-width="2"/);
  assert.match(svg, /stroke-linecap="round"/);
  assert.match(svg, /stroke-linejoin="round"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /<circle cx="12" cy="12" r="1.5"\/>/);
  assert.doesNotMatch(svg, /className|strokeWidth|onClick|Tooltip/);
  assert.ok(preview.warnings.some((w) => w.includes('<Tooltip>')));
});

test('previews when hovering a JSX usage of an imported component', (t) => {
  const root = jsxFixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'App.tsx');
  const text = "import { ChevronDownIcon } from './icons';\nexport const App = () => <ChevronDownIcon />;";
  assert.equal(previewAt(file, text, 'ChevronDownIcon', 1).kind, 'jsx-svg');
});

test('previews aliased imports and default exports wrapped in forwardRef', (t) => {
  const root = jsxFixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'App.tsx');
  const text = "import { StarIcon as Star, ChevronDownIcon as Chevron } from './icons';\n<Star />;";
  const star = previewAt(file, text, 'Star', 1);
  assert.equal(star.kind, 'jsx-svg');
  assert.match(star.svgMarkup, /<polygon points="5,0 6,4 10,4"\/>/);
  assert.match(star.svgMarkup, /<rect /);
  assert.match(star.svgMarkup, /<line /);
  assert.doesNotMatch(star.svgMarkup, /ref=/);
  assert.equal(previewAt(file, text, 'Chevron', 1).kind, 'jsx-svg');
});

test('reports a fallback for SVG components without static content', (t) => {
  const root = jsxFixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'App.tsx');
  const text = "import { Empty } from './icons';";
  assert.equal(previewAt(file, text, 'Empty').kind, 'unsupported');
});

test('ignores non-SVG components, circular re-exports and unresolved imports', (t) => {
  const root = jsxFixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'App.tsx');
  const text = "import { Button, Loop, Nope } from './icons';\nimport { X } from './missing';\nimport { Y } from 'react';";
  for (const name of ['Button', 'Loop', 'Nope', 'X', 'Y']) {
    assert.equal(previewAt(file, text, name), undefined, name);
  }
});

test('still previews image assets imported through barrels', (t) => {
  const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'App.tsx');
  const text = "import { Logo as Brand } from './barrels';\nimport Avatar from './assets/avatar.png';\n<Brand />;";
  assert.equal(previewAt(file, text, 'Brand', 1).assetPath, path.join(root, 'assets', 'logo.svg'));
  assert.equal(previewAt(file, text, 'Avatar').assetPath, path.join(root, 'assets', 'avatar.png'));
});
