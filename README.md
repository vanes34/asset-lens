# Asset Export Preview

A VS Code extension that shows a preview when you hover over images, SVG files and SVG icon components in your code. It works with nested barrel files, path aliases and popular icon libraries.

## What you can hover

**Names in TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, ...)**

- Imports: named, default, aliased and namespace (`import * as Icons`)
- Usages: `<ChevronDownIcon />`, `<Icons.ChevronDown />`, `IconMap.chevron`
- Exports in barrel files: `export { default as Logo } from './logo.svg'`

**Path strings**

- `'./logo.png'`, `'@/assets/logo.svg'`, `require('./logo.png')`, `new URL('./bg.png', import.meta.url)`
- Root paths served from `public/` or `static/`, such as `src="/images/hero.jpg"`
- CSS/SCSS/Less `url(...)` and HTML `src="..."`

**Vue and Svelte files**

- Imports in `<script>`, and component tags in the template (`<chevron-down-icon />` matches `ChevronDownIcon`)
- `.vue`/`.svelte` icon components whose template contains an `<svg>`

## How imports are followed

- Relative paths and `index.*` barrels, `export { X } from`, `export *`, `export * as Icons`
- `paths` and `baseUrl` from `tsconfig.json`/`jsconfig.json`, including `extends`
- Packages in `node_modules`, including symlinked monorepo workspaces and package.json `exports`
- Compiled CommonJS packages (`exports.X =`, `Object.defineProperty(exports, ...)`, `__exportStar`)
- Wrappers: `memo(Icon)`, `forwardRef(Inner)`, `observer(...)`, `withX(...)`
- Bundler query strings such as `./logo.svg?react` (svgr) and `?url`
- Unsaved changes in other open editors

## Icon formats that render

| Source | Example |
| --- | --- |
| JSX `<svg>` components | `export const Icon = () => <svg viewBox="0 0 24 24">...</svg>` |
| Compiled `createElement` / `jsx()` | Heroicons, most compiled icon packages |
| `createSvgIcon(<path/>)` | MUI icons |
| `createIcon({ viewBox, d \| path })` | Chakra UI |
| `createLucideIcon(name, [['path', {...}]])` | Lucide |
| `GenIcon({ tag, attr, child })` | react-icons |
| SVG and image files | SVG, PNG, JPG/JPEG, WebP, GIF, BMP, AVIF, ICO |

Lucide, Heroicons, MUI and react-icons have been checked against their published packages.

Nothing is executed: JSX is read statically. Literal values are used, and so are identifiers with literal defaults (`{ size = 24 }`), `const` values, `a ?? 'fallback'` and template strings. Children from `cond && <x/>`, ternaries and `.map()` over constant arrays are expanded. React attribute names are converted (`strokeWidth` → `stroke-width`, `className` → `class`). A `fill`/`stroke` set at runtime becomes `currentColor`. Spreads, event handlers and unknown elements are skipped, and the hover lists anything skipped that could change how the icon looks.

The hover also shows the image's dimensions and file size, or the component's declared size, plus a link to the source file.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `assetExportPreview.previewSize` | `64` | Longest side, in pixels, of SVG component previews |
| `assetExportPreview.previewColor` | `""` | Colour used for `currentColor`; empty means one that suits the current theme |
| `assetExportPreview.maxImageSize` | `256` | Image files larger than this are scaled down in the hover |

## Not supported yet

- Icons whose shapes are computed at runtime (fetched data, `.map()` over props, non-constant arrays)
- Colours that come from CSS classes such as Tailwind `text-red-500`
- Dynamic `import()` and webpack `require.context`
- Remote `http(s)` images

## Requirements

- Node.js 18 or newer
- VS Code 1.85 or newer

## Run locally

```bash
npm install
npm test
```

Open this folder in VS Code and press `F5`. It compiles first, then opens an Extension Development Host window. Open a project in that window and hover over an icon or image. Run `npm run watch` while you edit to recompile on save.

## Package as a VSIX

```bash
npm run package-extension
code --install-extension asset-export-preview-0.1.0.vsix
```

Before publishing, replace `your-publisher-name` in `package.json` with your Visual Studio Marketplace publisher ID.

## Known limitations

- Generated SVGs are shown as inline `data:` images, and image files use `file:` URIs. Both depend on VS Code's Markdown hover rendering; check them in your target VS Code version and in remote setups (SSH, WSL, Codespaces).
- When resolution fails (missing files, cycles, unsupported syntax), no hover is shown. VS Code is never interrupted.
