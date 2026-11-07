# figma-to-manifest

CLI tool. Converts `raw.json` (output of the Figma plugin `air-ds-manifest-exporter`) into a `skeleton-page/` directory (with `manifest.json` and `chunks/`) — a compact, AI-friendly description of a Figma frame in which Figma variable names are replaced with `--lib-*` tokens.

## Installation

```bash
npm install --save-dev figma-to-manifest
```

For local testing (from a packed archive, before publishing):

```bash
# In the figma-to-manifest repository
npm pack

# In your target project
npm install <path-to>/figma-to-manifest-0.1.0.tgz
```

## Usage

```bash
figma-to-manifest raw.json
# → creates ./skeleton-page/manifest.json (+ ./skeleton-page/chunks/*.json if split)

figma-to-manifest raw.json --out=custom/path/manifest.json
# → creates ./custom/path/manifest.json
```

### Options

| Option | Description |
|---|---|
| `--map=<path>` | Explicit path to `figma-tokens-map.yaml`. |
| `--code-map=<path>` | Explicit path to `figma-to-code.map.yaml`. |
| `--out=<path>` | Output manifest path (default: `skeleton-page/manifest.json`). |
| `--threshold=<bytes>` | Split threshold in bytes (default: `20480`). |
| `--quiet` | Suppress progress and statistics output. |
| `-h`, `--help` | Show help. |

## How the tool locates the YAML maps

### `figma-tokens-map.yaml` (Figma → `--lib-*`)

1. CLI argument `--map=<path>`.
2. Environment variable `FIGMA_TOKENS_MAP`.
3. 3. Inside an installed package that exposes the map via `exports` (e.g. a design-system package).
4. `./figma-tokens-map.yaml` in the current working directory.

### `figma-to-code.map.yaml` (Figma component → Angular snippet)

1. CLI argument `--code-map=<path>`.
2. Environment variable `FIGMA_TO_CODE_MAP`.
3. 3. Inside an installed package that exposes the map via `exports` (e.g. a design-system package).
4. `./figma-to-code.map.yaml` in the current working directory.

If a map is not found, the tool exits with an error and prints the list of checked paths.

## What it does

For each node in the tree:

- Copies structural fields: `name`, `type`, `mainComponent`, `text`, `font`, `layout`, `size`, `fills`, `strokes`, `children`.
- For each entry in `boundVariables`, strips the `[Collection]` suffix and looks up the name in `figma-tokens-map.yaml`:
  - **Found** → replaced with a `--lib-*` token.
  - **Not found** → marked with the prefix `UNMAPPED: ` and passed through as is.
- Discards `paragraphspacing/*` and `paragraphindent/*` (always 0, noise).
- For nodes matched in `figma-to-code.map.yaml`, replaces the whole subtree with `$snippet` and `$inputs`.
- Resolves icons: strips the `Family/` prefix (e.g. `Arrows/chevron-right` → `chevron-right`), applies the `icons` mapping from `figma-to-code.map.yaml`.
- Removes `null`/`undefined` fields from `$inputs` (no empty bindings).
- Deduplicates repeating unmapped components (`$total`).
- Splits the manifest into chunks if it exceeds the threshold (20 KB by default).

## Output structure

```
skeleton-page/
  manifest.json       # skeleton (with CHUNK_REF placeholders)
  chunks/
    <name>-chunk-1.json
    <name>-chunk-2.json
```

- If the manifest is smaller than the threshold, no `chunks/` folder is created.
- `manifest.chunks[]` lists every chunk with `file`, `name`, and `reason`.

## What the AI agent does with `UNMAPPED`

The agent (Cline) must handle `UNMAPPED: <name>` entries according to `.clinerules/02-tokens-variables.md`:

1. Try to find a matching `--lib-*` token via Tokens MCP (`search_tokens`).
2. If a token exists — use it and leave `// AUTONOMY(token-missing): <name> — matched <token>`.
3. If no token exists — use a local CSS variable with a `TODO`.
4. Write an entry to `warnings.json`.

The transformer does not attempt to resolve `UNMAPPED` itself — that is the agent's responsibility.

## `raw.json` format

The tool expects as input the JSON produced by the Figma plugin `air-ds-manifest-exporter`. The structure is a tree of Figma nodes with the fields:

- `name`, `type`
- `mainComponent` (for INSTANCE nodes)
- `componentProps` (BOOLEAN, TEXT, VARIANT, INSTANCE_SWAP)
- `text`, `font` (for TEXT nodes)
- `layout`, `size`, `position`
- `fills`, `strokes`
- `boundVariables` — map `property → "variable-name [Collection]"`
- `children` — nested nodes

## `manifest.json` format

```json
{
  "screen": {
    "name": "Catalog Home",
    "type": "FRAME"
  },
  "root": {
    "name": "Catalog Home",
    "type": "FRAME",
    "layout": { ... },
    "tokens": {
      "fills.0": "--lib-background-color-screen-base"
    },
    "children": [ ... ]
  },
  "chunks": [
    {
      "file": "block-filter-section-chunk-1.json",
      "name": "Block_filter section",
      "reason": "size"
    }
  ]
}
```

## Example

**Input (`raw.json`, fragment):**

```json
{
  "name": "XText",
  "type": "TEXT",
  "text": "HA",
  "font": { "size": 12, "family": "DM Sans", "style": "SemiBold" },
  "boundVariables": {
    "fills.0": "color/global/neutral/text/accent [Themes]",
    "fontSize.0": "typography/fontsize/xs [Primitives]",
    "fontWeight.0": "typography/font weight/semibold [Primitives]"
  }
}
```

**Output (`manifest.json`, fragment):**

```json
{
  "name": "XText",
  "type": "TEXT",
  "text": "HA",
  "font": { "size": 12, "family": "DM Sans", "style": "SemiBold" },
  "tokens": {
    "fills.0": "--lib-text-color-neutral-accent",
    "fontSize.0": "--lib-font-size-xs",
    "fontWeight.0": "UNMAPPED: typography/font weight/semibold"
  }
}
```

## Dependencies

- **Node.js** ≥ 20.19.0
- **`js-yaml`** ^4.1.0
-- **`figma-tokens-map.yaml`** and **`figma-to-code.map.yaml`** — must be provided via CLI flags, env vars, an installed package that exposes them, or the current working directory.
