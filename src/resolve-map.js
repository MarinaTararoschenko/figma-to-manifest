import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Resolves the path to figma-tokens-map.yaml.
 *
 * Priority:
 *   1. Explicit path (CLI --map=...)
 *   2. FIGMA_TOKENS_MAP env var
 *   3. Inside an installed package that exposes the map via exports
 *   4. ./figma-tokens-map.yaml in current working directory
 */
export function resolveMapPath(explicitPath) {
  const candidates = [];

  if (explicitPath) candidates.push(explicitPath);
  if (process.env.FIGMA_TOKENS_MAP) candidates.push(process.env.FIGMA_TOKENS_MAP);

  const fromAirDs = tryResolveFromPackage();
  if (fromAirDs) candidates.push(fromAirDs);

  candidates.push(resolve(process.cwd(), 'figma-tokens-map.yaml'));

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  throw new Error(
    `figma-tokens-map.yaml not found. Tried:\n` +
    candidates.map((c) => `  - ${c}`).join('\n') +
    `\n\nPass --map=<path>, set FIGMA_TOKENS_MAP, ` +
    `or set FIGMA_TOKENS_MAP_PACKAGE to a package that ships the map.`
  );
}

function tryResolveFromPackage() {
  const pkg = process.env.FIGMA_TOKENS_MAP_PACKAGE;
  if (!pkg) return null;
  try {
    const require = createRequire(resolve(process.cwd(), 'noop.js'));
    return require.resolve(`${pkg}/figma-tokens-map.yaml`);
  } catch {
    return null;
  }
}
