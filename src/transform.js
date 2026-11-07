import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { resolveMapPath } from './resolve-map.js';
import { transformNode, collectStats } from './walk.js';
import { splitManifest } from './split-manifest.js';

/**
 * Resolve the path to figma-to-code.map.yaml.
 * Priority:
 *   1. CLI --code-map=<path>
 *   2. FIGMA_TO_CODE_MAP env var
  *   3. Inside an installed package that exposes the map via exports
 *   4. ./figma-to-code.map.yaml in the current working directory
 */
function resolveCodeMapPath(explicitPath) {
  const candidates = [];

  if (explicitPath) candidates.push(explicitPath);
  if (process.env.FIGMA_TO_CODE_MAP) candidates.push(process.env.FIGMA_TO_CODE_MAP);

  const fromPackage = tryResolveCodeMapFromPackage();
  if (fromPackage) candidates.push(fromPackage);

  candidates.push(resolve(process.cwd(), 'figma-to-code.map.yaml'));

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  throw new Error(
    `figma-to-code.map.yaml not found. Tried:\n` +
    candidates.map((c) => `  - ${c}`).join('\n') +
    `\n\nPass --code-map=<path>, set FIGMA_TO_CODE_MAP, ` +
    `or set FIGMA_TO_CODE_MAP_PACKAGE to a package that ships the map.`
  );
}

function tryResolveCodeMapFromPackage() {
  const pkg = process.env.FIGMA_TO_CODE_MAP_PACKAGE;
  if (!pkg) return null;
  try {
    const require = createRequire(resolve(process.cwd(), 'noop.js'));
    return require.resolve(`${pkg}/figma-to-code.map.yaml`);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { raw: null, out: null, map: null, codeMap: null, quiet: false, help: false };

  for (const a of argv) {
    if (a.startsWith('--raw=')) args.raw = a.slice(6);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a.startsWith('--map=')) args.map = a.slice(6);
    else if (a.startsWith('--code-map=')) args.codeMap = a.slice(11);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-') && !args.raw) args.raw = a;
    else if (!a.startsWith('-') && !args.out) args.out = a;
  }

  return args;
}

function printHelp() {
  console.log(`
Usage: figma-to-manifest <raw.json> [out.json] [options]

Arguments:
  raw.json              Output of the air-ds-manifest-exporter Figma plugin
  out.json              Output manifest path (default: skeleton-page/manifest.json)

Options:
  --map=<path>          Path to figma-tokens-map.yaml.
  --code-map=<path>     Path to figma-to-code.map.yaml.
                        Default: resolved via FIGMA_TO_CODE_MAP_PACKAGE
                        (package with the map), fallback to ./figma-to-code.map.yaml.
  --quiet               Suppress progress and stats.
  -h, --help            Show this help.
`);
}

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.raw) {
    printHelp();
    throw new Error('Missing <raw.json> argument.');
  }

  const rawPath = resolve(process.cwd(), args.raw);
  const outPath = resolve(process.cwd(), args.out || 'skeleton-page/manifest.json');
  const mapPath = resolveMapPath(
    args.map ? resolve(process.cwd(), args.map) : null
  );
  const codeMapPath = resolveCodeMapPath(
    args.codeMap ? resolve(process.cwd(), args.codeMap) : null
  );

  if (!existsSync(rawPath)) {
    throw new Error(`raw.json not found: ${rawPath}`);
  }

  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const tokenMapDoc = yaml.load(readFileSync(mapPath, 'utf8'));
  const tokenMap = tokenMapDoc?.tokens || {};

  const codeMap = yaml.load(readFileSync(codeMapPath, 'utf8'));

  if (!args.quiet) {
    console.log(`raw.json:           ${rawPath}`);
    console.log(`figma-tokens-map:   ${mapPath}`);
    console.log(`figma-to-code map:  ${codeMapPath}`);
    console.log(`Token mappings:     ${Object.keys(tokenMap).length}`);
    console.log(`Code components:    ${codeMap?.components?.length || 0}`);
    console.log('');
  }

  const manifest = {
    // Uncomment for local debugging to see the exact resolved paths.
    // Do NOT include in the final manifest — it leaks absolute paths
    // and bloats the agent's context.
    // source: {
    //   raw: rawPath,
    //   tokenMap: mapPath,
    //   codeMap: codeMapPath,
    // },
    screen: {
      name: raw.name,
      type: raw.type,
    },
    root: transformNode(raw, tokenMap, codeMap),
  };

  const stats = collectStats(manifest.root);

  const skeletonDir = dirname(outPath);
  const chunkDir = resolve(skeletonDir, 'chunks');

  // Clear the skeleton directory so stale files from previous runs do not linger.
  if (existsSync(skeletonDir)) {
    rmSync(skeletonDir, { recursive: true, force: true });
  }
  mkdirSync(skeletonDir, { recursive: true });

  const split = splitManifest(manifest, {
    threshold: 20 * 1024,
    outDir: chunkDir,
  });

  writeFileSync(outPath, JSON.stringify(split.manifest, null, 2));

  if (!args.quiet) {
    console.log(`✅ Wrote ${outPath}`);
    console.log(`   Total bindings: ${stats.total}`);
    console.log(`   Mapped:         ${stats.mapped}`);
    console.log(`   Unmapped:       ${stats.unmapped}`);
    if (split.split) {
      console.log(`   Split: ${split.chunks.length} chunk(s) → ${chunkDir}`);
      for (const chunk of split.chunks) {
        console.log(`     - ${chunk.file} (${chunk.reason}: ${chunk.name})`);
      }
    } else {
      console.log(`   Split: none (${split.totalSize} bytes ≤ threshold)`);
    }
  }
}
