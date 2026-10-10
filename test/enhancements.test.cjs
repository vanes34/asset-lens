const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssetResolver } = require('../out/resolver/assetResolver.js');
const { imageSizeFromBuffer, svgSize } = require('../out/resolver/imageSize.js');

const SVG_COMPONENT = (name) =>
  `export const ${name} = () => <svg viewBox="0 0 24 24"><path d="M1 1" /></svg>;\n`;

function project(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-export-preview-enh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

function hover(file, text, needle, { occurrence = 0, resolver = new AssetResolver() } = {}) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(needle, index + 1);
  assert.notEqual(index, -1, `needle ${needle} not found`);
  return resolver.resolvePreviewAtPosition(file, text, index + Math.floor(needle.length / 2));
}

test('resolves tsconfig path aliases to components and assets', (t) => {
  const root = project(t, {
    'tsconfig.json': '{ // comments are allowed\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "@icons": ["src/icons/index.ts"] } } }',
    'src/icons/index.ts': "export { Chevron } from './Chevron';",
    'src/icons/Chevron.tsx': SVG_COMPONENT('Chevron'),
    'src/assets/logo.png': 'png',
  });
  const file = path.join(root, 'src/app/App.tsx');
  const text = "import { Chevron } from '@icons';\nimport Logo from '@/assets/logo.png';\nimport { Chevron as C2 } from '@/icons';";
  assert.equal(hover(file, text, 'Chevron').kind, 'jsx-svg');
  assert.equal(hover(file, text, 'Logo').assetPath, path.join(root, 'src/assets/logo.png'));
  assert.equal(hover(file, text, 'C2').kind, 'jsx-svg');
});

test('follows tsconfig extends and jsconfig', (t) => {
  const root = project(t, {
    'tsconfig.base.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    'tsconfig.json': '{ "extends": "./tsconfig.base.json" }',
    'src/Star.tsx': SVG_COMPONENT('Star'),
    'web/jsconfig.json': '{ "compilerOptions": { "baseUrl": "lib" } }',
    'web/lib/icons/Moon.jsx': SVG_COMPONENT('Moon'),
  });
  assert.equal(hover(path.join(root, 'src/App.tsx'), "import { Star } from '~/Star';", 'Star').kind, 'jsx-svg');
  assert.equal(hover(path.join(root, 'web/App.jsx'), "import { Moon } from 'icons/Moon';", 'Moon').kind, 'jsx-svg');
});

test('resolves packages: workspaces, exports maps and module entries', (t) => {
  const root = project(t, {
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': { types: './src/index.d.ts', import: './src/index.ts' }, './icons/*': './src/icons/*.tsx' } }),
    'packages/ui/src/index.ts': "export * from './icons/Bell';",
    'packages/ui/src/icons/Bell.tsx': SVG_COMPONENT('Bell'),
    'node_modules/legacy-icons/package.json': JSON.stringify({ name: 'legacy-icons', main: 'dist/index.cjs', module: 'dist/index.mjs' }),
    'node_modules/legacy-icons/dist/index.mjs': SVG_COMPONENT('Heart'),
  });
  fs.mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true });
  fs.symlinkSync(path.join(root, 'packages/ui'), path.join(root, 'node_modules/@acme/ui'), 'dir');

  const file = path.join(root, 'app/App.tsx');
  const text = "import { Bell } from '@acme/ui';\nimport { Bell as B2 } from '@acme/ui/icons/Bell';\nimport { Heart } from 'legacy-icons';";
  const bell = hover(file, text, 'Bell');
  assert.equal(bell.kind, 'jsx-svg');
  assert.equal(bell.sourcePath, path.join(root, 'packages/ui/src/icons/Bell.tsx'));
  assert.equal(hover(file, text, 'B2').kind, 'jsx-svg');
  assert.equal(hover(file, text, 'Heart').kind, 'jsx-svg');
});

test('follows memo/forwardRef wrappers around separately declared components', (t) => {
  const root = project(t, {
    'Icon.tsx': [
      'function Inner(props, ref) { return <svg viewBox="0 0 24 24"><circle r="4" /></svg>; }',
      'const Wrapped = React.memo(forwardRef(Inner));',
      'export default Wrapped;',
      'export const Other = memo(Inner) as typeof Inner;',
    ].join('\n'),
  });
  const file = path.join(root, 'App.tsx');
  const text = "import Icon, { Other } from './Icon';";
  assert.equal(hover(file, text, 'Icon').kind, 'jsx-svg');
  assert.equal(hover(file, text, 'Other').kind, 'jsx-svg');
});

test('resolves namespace imports, export * as and icon objects', (t) => {
  const root = project(t, {
    'icons/Chevron.tsx': SVG_COMPONENT('Chevron'),
    'icons/index.ts': "export * from './Chevron';",
    'barrel.ts': "export * as Icons from './icons';",
    'map.ts': "import { Chevron } from './icons';\nexport const IconMap = { chevron: Chevron, Chevron };",
  });
  const file = path.join(root, 'App.tsx');
  const text = [
    "import * as Icons from './icons';",
    "import { Icons as Re } from './barrel';",
    "import { IconMap } from './map';",
    '<Icons.Chevron />; <Re.Chevron />; IconMap.chevron; IconMap.Chevron; Icons.Missing;',
  ].join('\n');
  assert.equal(hover(file, text, 'Chevron', { occurrence: 0 }).kind, 'jsx-svg');
  assert.equal(hover(file, text, 'Chevron', { occurrence: 1 }).kind, 'jsx-svg');
  assert.equal(hover(file, text, 'chevron').kind, 'jsx-svg');
  assert.equal(hover(file, text, 'Chevron', { occurrence: 2 }).kind, 'jsx-svg');
  assert.equal(hover(file, text, 'Missing'), undefined);
  assert.equal(hover(file, text, 'Icons'), undefined, 'hovering the namespace itself shows nothing');
});

test('converts compiled React.createElement output (Heroicons style)', (t) => {
  const root = project(t, {
    'ChevronDownIcon.js': [
      'import * as React from "react";',
      'function ChevronDownIcon({ title, titleId, ...props }, svgRef) {',
      '  return /*#__PURE__*/React.createElement("svg", Object.assign({',
      '    xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true", ref: svgRef',
      '  }, props), title ? /*#__PURE__*/React.createElement("title", { id: titleId }, title) : null,',
      '  /*#__PURE__*/React.createElement("path", { fillRule: "evenodd", d: "M12 15l-6-6" }));',
      '}',
      'const ForwardRef = /*#__PURE__*/ React.forwardRef(ChevronDownIcon);',
      'export default ForwardRef;',
    ].join('\n'),
  });
  const preview = hover(path.join(root, 'App.tsx'), "import ChevronDownIcon from './ChevronDownIcon';", 'ChevronDownIcon');
  assert.equal(preview.kind, 'jsx-svg');
  assert.match(preview.svgMarkup, /<path fill-rule="evenodd" d="M12 15l-6-6"\/>/);
  assert.match(preview.svgMarkup, /aria-hidden="true"/);
  assert.doesNotMatch(preview.svgMarkup, /ref=/);
});

test('converts jsx-runtime output and MUI createSvgIcon in CommonJS', (t) => {
  const root = project(t, {
    'ExpandMore.js': [
      '"use strict";',
      'var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");',
      'Object.defineProperty(exports, "__esModule", { value: true });',
      'exports.default = void 0;',
      'var _createSvgIcon = _interopRequireDefault(require("./utils/createSvgIcon"));',
      'var _jsxRuntime = require("react/jsx-runtime");',
      'var _default = exports.default = (0, _createSvgIcon.default)( /*#__PURE__*/(0, _jsxRuntime.jsx)("path", {',
      '  d: "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"',
      '}), \'ExpandMore\');',
    ].join('\n'),
    'index.js': [
      '"use strict";',
      'var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");',
      'Object.defineProperty(exports, "ExpandMore", { enumerable: true, get: function () { return _ExpandMore.default; } });',
      'var _ExpandMore = _interopRequireDefault(require("./ExpandMore"));',
    ].join('\n'),
  });
  const file = path.join(root, 'App.tsx');
  const text = "import ExpandMore from './ExpandMore';\nimport { ExpandMore as E2 } from './index';";
  for (const name of ['ExpandMore', 'E2']) {
    const preview = hover(file, text, name);
    assert.equal(preview.kind, 'jsx-svg', name);
    assert.match(preview.svgMarkup, /viewBox="0 0 24 24"/);
    assert.match(preview.svgMarkup, /fill="currentColor"/);
    assert.match(preview.svgMarkup, /<path d="M16\.59 8\.59/);
    assert.doesNotMatch(preview.svgMarkup, /ExpandMore/);
  }
});

test('converts Lucide-style icon nodes and Chakra createIcon', (t) => {
  const root = project(t, {
    'chevron-down.js': [
      "import createLucideIcon from '../createLucideIcon.js';",
      'const __iconNode = [["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }], ["circle", { cx: "12", cy: "12", r: "1", key: "x" }]];',
      'const ChevronDown = createLucideIcon("chevron-down", __iconNode);',
      'export { __iconNode, ChevronDown as default };',
    ].join('\n'),
    'lucide.js': "export { default as ChevronDown, default as ChevronDownIcon } from './chevron-down.js';",
    'chakra.ts': "export const Phone = createIcon({ displayName: 'Phone', viewBox: '0 0 32 32', d: 'M2 2h4' });",
  });
  const file = path.join(root, 'App.tsx');
  const text = "import { ChevronDownIcon } from './lucide';\nimport { Phone } from './chakra';";
  const lucide = hover(file, text, 'ChevronDownIcon');
  assert.equal(lucide.kind, 'jsx-svg');
  assert.match(lucide.svgMarkup, /stroke="currentColor"/);
  assert.match(lucide.svgMarkup, /stroke-width="2"/);
  assert.match(lucide.svgMarkup, /<path d="m6 9 6 6 6-6"\/><circle cx="12" cy="12" r="1"\/>/);
  assert.doesNotMatch(lucide.svgMarkup, /key=|chevron-down/);

  const chakra = hover(file, text, 'Phone');
  assert.equal(chakra.kind, 'jsx-svg');
  assert.match(chakra.svgMarkup, /viewBox="0 0 32 32"/);
  assert.match(chakra.svgMarkup, /<path d="M2 2h4"\/>/);
});

test('expands conditional children and .map over constant arrays', (t) => {
  const root = project(t, {
    'Icon.tsx': [
      "const PATHS = ['M1 1', 'M2 2'];",
      "const DOTS = [{ x: 3, fill: 'red' }, { x: 4, fill: 'blue' }];",
      'export const Icon = ({ title, filled = true }) => (',
      '  <svg viewBox="0 0 24 24">',
      '    {title && <title>{title}</title>}',
      '    {filled ? <rect width="1" height="1" /> : <circle r="1" />}',
      '    {PATHS.map((d, i) => <path key={i} d={d} />)}',
      '    {DOTS.map(({ x, fill }) => <circle cx={x} fill={fill} r="1" />)}',
      '    {DOTS.map((dot) => { return <line x1={dot.x} />; })}',
      '    {props.items.map((item) => <path d={item} />)}',
      '  </svg>',
      ');',
    ].join('\n'),
  });
  const preview = hover(path.join(root, 'App.tsx'), "import { Icon } from './Icon';", 'Icon');
  assert.equal(preview.kind, 'jsx-svg');
  const svg = preview.svgMarkup;
  assert.match(svg, /<rect width="1" height="1"\/>/);
  assert.doesNotMatch(svg, /<circle r="1"\/>/);
  assert.match(svg, /<path d="M1 1"\/><path d="M2 2"\/>/);
  assert.match(svg, /<circle cx="3" fill="red" r="1"\/><circle cx="4" fill="blue" r="1"\/>/);
  assert.match(svg, /<line x1="3"\/><line x1="4"\/>/);
  assert.ok(preview.warnings.some((w) => /dynamic child/.test(w)));
});

test('component parameter defaults win over file-level constants', (t) => {
  const root = project(t, {
    'Icon.tsx': [
      "const color = 'red';",
      'const Other = ({ size = 99 }) => null;',
      "export const Icon = ({ size = 10, color = 'green' }) => <svg width={size} height={size}><path stroke={color} d=\"M0 0\" /></svg>;",
    ].join('\n'),
  });
  const preview = hover(path.join(root, 'App.tsx'), "import { Icon } from './Icon';", 'Icon');
  assert.match(preview.svgMarkup, /stroke="green"/);
  assert.equal(preview.originalSize, '10×10');
});

test('uses preview size and colour options', (t) => {
  const root = project(t, { 'Icon.tsx': 'export const Icon = () => <svg viewBox="0 0 20 10"><path d="M0 0" /></svg>;' });
  const preview = new AssetResolver().resolvePreviewAtPosition(
    path.join(root, 'App.tsx'), "import { Icon } from './Icon';", 10, { size: 100, color: '#123456' });
  assert.match(preview.svgMarkup, /width="100" height="50"/);
  assert.match(preview.svgMarkup, /color="#123456"/);
  assert.equal(preview.originalSize, '20×10 viewBox');
});

test('previews asset paths in strings, require() and new URL()', (t) => {
  const root = project(t, {
    'package.json': '{}',
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    'public/images/hero.jpg': 'jpg',
    'src/assets/logo.svg': '<svg/>',
    'src/assets/bg.png': 'png',
  });
  const file = path.join(root, 'src/App.tsx');
  const text = [
    "const logo = require('./assets/logo.svg');",
    "const bg = new URL('./assets/bg.png', import.meta.url).href;",
    "<img src=\"/images/hero.jpg\" />; <img src={'@/assets/bg.png?w=100'} />;",
    "import Svg from './assets/logo.svg?react';",
    'logo; bg; "./not-an-asset.ts";',
  ].join('\n');
  assert.equal(hover(file, text, 'logo', { occurrence: 2 }).assetPath, path.join(root, 'src/assets/logo.svg'));
  assert.equal(hover(file, text, 'bg', { occurrence: 3 }).assetPath, path.join(root, 'src/assets/bg.png'));
  assert.equal(hover(file, text, 'hero.jpg').assetPath, path.join(root, 'public/images/hero.jpg'));
  assert.equal(hover(file, text, 'bg.png?w').assetPath, path.join(root, 'src/assets/bg.png'));
  assert.equal(hover(file, text, 'Svg').assetPath, path.join(root, 'src/assets/logo.svg'));
  assert.equal(hover(file, text, 'not-an-asset'), undefined);
  assert.equal(hover(file, text, "'./assets/logo.svg'").kind, 'asset', 'hovering an import path string');
});

test('previews url() and src paths in CSS and HTML', (t) => {
  const root = project(t, { 'styles/icons/a.svg': '<svg/>', 'img/b.png': 'png', 'package.json': '{}' });
  const css = 'body { background: url(./icons/a.svg) no-repeat; mask: url("icons/a.svg"); }';
  assert.equal(hover(path.join(root, 'styles/main.css'), css, 'a.svg').assetPath, path.join(root, 'styles/icons/a.svg'));
  assert.equal(hover(path.join(root, 'styles/main.css'), css, 'a.svg', { occurrence: 1 }).assetPath, path.join(root, 'styles/icons/a.svg'));
  const html = '<img src="/img/b.png" alt="x">';
  assert.equal(hover(path.join(root, 'index.html'), html, 'b.png').assetPath, path.join(root, 'img/b.png'));
});

test('previews imports and template tags in Vue and Svelte files', (t) => {
  const root = project(t, {
    'icons/ChevronDownIcon.tsx': SVG_COMPONENT('ChevronDownIcon'),
    'icons/Bell.vue': [
      '<template>',
      '  <svg :width="size" viewBox="0 0 24 24" @click="emit(\'x\')" v-bind="$attrs">',
      '    <!-- bell -->',
      '    <path d="M4 4h16" stroke-width="2" />',
      '    <title>{{ title }}</title>',
      '  </svg>',
      '</template>',
      '<script setup lang="ts">defineProps<{ size?: number }>();</script>',
    ].join('\n'),
    'icons/Star.svelte': '<script>export let color;</script>\n<svg viewBox="0 0 10 10" fill={color} on:click>{#if true}<circle r="2" />{/if}</svg>',
  });
  const vue = [
    '<template><chevron-down-icon /><Bell /><Star /></template>',
    '<script setup lang="ts">',
    "import { ChevronDownIcon } from './icons/ChevronDownIcon';",
    "import Bell from './icons/Bell.vue';",
    "import Star from './icons/Star.svelte';",
    '</script>',
  ].join('\n');
  const file = path.join(root, 'App.vue');
  assert.equal(hover(file, vue, 'chevron-down-icon').kind, 'jsx-svg');
  assert.equal(hover(file, vue, 'ChevronDownIcon').kind, 'jsx-svg');

  const bell = hover(file, vue, 'Bell');
  assert.equal(bell.kind, 'jsx-svg');
  assert.match(bell.svgMarkup, /<path d="M4 4h16" stroke-width="2"\/>/);
  assert.doesNotMatch(bell.svgMarkup, /@click|v-bind|:width|\{\{/);

  const star = hover(file, vue, 'Star');
  assert.equal(star.kind, 'jsx-svg');
  assert.match(star.svgMarkup, /fill="currentColor"/);
  assert.match(star.svgMarkup, /<circle r="2"\/>/);
});

test('uses unsaved editor contents when provided', (t) => {
  const root = project(t, { 'Icon.tsx': 'export const Icon = () => null;' });
  const iconFile = path.join(root, 'Icon.tsx');
  const resolver = new AssetResolver({
    readFile: (file) => (file === iconFile ? SVG_COMPONENT('Icon') : undefined),
  });
  assert.equal(hover(path.join(root, 'App.tsx'), "import { Icon } from './Icon';", 'Icon', { resolver }).kind, 'jsx-svg');
  assert.equal(hover(path.join(root, 'App.tsx'), "import { Icon } from './Icon';", 'Icon'), undefined);
});

test('survives cyclic aliases, broken configs and deep chains', (t) => {
  const files = {
    'tsconfig.json': '{ this is not json',
    'a.ts': "export * from './b';",
    'b.ts': "export * from './a';",
    'self.ts': "export { Self as Self2 } from './self';\nexport { Self2 as Self } from './self';",
  };
  for (let i = 0; i < 50; i++) files[`chain${i}.ts`] = `export { X } from './chain${i + 1}';`;
  const root = project(t, files);
  const file = path.join(root, 'App.tsx');
  const text = "import { Nope } from './a';\nimport { Self } from './self';\nimport { X } from './chain0';\nimport { Y } from '@/y';";
  for (const name of ['Nope', 'Self', 'X', 'Y']) assert.equal(hover(file, text, name), undefined, name);
});

test('reads image dimensions from file headers', () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSizeFromBuffer(png), { width: 640, height: 480 });

  const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
  assert.deepEqual(imageSizeFromBuffer(gif), { width: 32, height: 16 });

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03]);
  assert.deepEqual(imageSizeFromBuffer(jpeg), { width: 200, height: 100 });

  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 0, 48]);
  assert.deepEqual(imageSizeFromBuffer(ico), { width: 256, height: 48 });

  assert.deepEqual(svgSize('<svg width="24px" height="12" viewBox="0 0 1 1">'), { width: 24, height: 12 });
  assert.deepEqual(svgSize('<svg width="100%" viewBox="0 0 48 32">'), { width: 48, height: 32 });
  assert.equal(imageSizeFromBuffer(Buffer.from('not an image')), undefined);
});

test('converts react-icons GenIcon data trees and drops empty dynamic titles', (t) => {
  const root = project(t, {
    'fa.mjs': [
      "import { GenIcon } from '../lib/index.mjs';",
      'export function FaStar (props) {',
      '  return GenIcon({"tag":"svg","attr":{"viewBox":"0 0 576 512"},"child":[{"tag":"path","attr":{"d":"M259 17"},"child":[]}]})(props);',
      '};',
    ].join('\n'),
    'Titled.tsx': 'export const Titled = ({ title, titleId }) => <svg viewBox="0 0 24 24" aria-labelledby={titleId}><title id={titleId}>{title}</title><path d="M0 0" /></svg>;',
  });
  const file = path.join(root, 'App.tsx');
  const text = "import { FaStar } from './fa.mjs';\nimport { Titled } from './Titled';";
  const star = hover(file, text, 'FaStar');
  assert.equal(star.kind, 'jsx-svg');
  assert.match(star.svgMarkup, /viewBox="0 0 576 512" fill="currentColor" stroke="currentColor" stroke-width="0"/);
  assert.match(star.svgMarkup, /<path d="M259 17"\/>/);

  const titled = hover(file, text, 'Titled');
  assert.doesNotMatch(titled.svgMarkup, /<title/);
  assert.deepEqual(titled.warnings, []);
});
