// ============================================================================
// Manifest splitter
// Splits a manifest into a root skeleton and chunk files. Uses two passes:
//   1. Mark: post-order, sets flags (__repeatChildren, __hasSnippetChild).
//   2. Split: post-order, emits chunks based on the flags.
// A node becomes a chunk only if it contains snippet children or has
// three or more identical unmapped direct children (or a $total marker).
// Library components (nodes with $snippet) are never split candidates.
// ============================================================================

import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Wrapper names that carry no meaning. Never split on these.
const CONTEXT_NOISE = new Set([
  'container', 'content', 'frame', 'group', 'wrapper', 'body',
  'children', 'slot', 'root', 'page',
]);

// Default size threshold in bytes, measured the same way the file is written.
const DEFAULT_THRESHOLD = 20 * 1024;

// Minimum number of identical unmapped children to treat a parent
// as a repeating block.
const REPEAT_MIN = 3;

// ============================================================================
// HELPERS
// ============================================================================

function sizeOf(node) {
  return Buffer.byteLength(JSON.stringify(node, null, 2), 'utf8');
}

function isNoise(node) {
  const raw = (node.name || '').replace(/^\./, '').split(/[\/\s-]/)[0].toLowerCase();
  return CONTEXT_NOISE.has(raw);
}

function hasSnippet(node) {
  return typeof node.$snippet === 'string' && node.$snippet.length > 0;
}

function isComponent(node) {
  return node.type === 'INSTANCE' && !!node.mainComponent?.name;
}

function isLeaf(node) {
  if (node.type === 'TEXT' || node.type === 'VECTOR') return true;
  if (node.type === 'INSTANCE' && !(node.children && node.children.length)) return true;
  return false;
}

function slugify(name) {
  return String(name)
    .replace(/^\./, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'chunk';
}

// ============================================================================
// PHASE 1: MARK
// ============================================================================

// Post-order walk. Sets two flags on each node:
//   __repeatChildren    — three or more identical unmapped direct children,
//                         or a direct child carrying $total >= REPEAT_MIN
//   __hasSnippetChild   — at least one snippet node anywhere in the subtree
function markNode(node) {
  if (node.children?.length) {
    for (const child of node.children) markNode(child);
  }

  // Repeat: identical unmapped direct children, or a $total marker.
  let repeat = false;
  const counts = new Map();
  for (const child of node.children || []) {
    if (child.$total && child.$total >= REPEAT_MIN) {
      repeat = true;
    }
    if (!isComponent(child)) continue;
    if (hasSnippet(child)) continue;
    const name = child.mainComponent.name;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (!repeat) {
    for (const count of counts.values()) {
      if (count >= REPEAT_MIN) { repeat = true; break; }
    }
  }
  node.__repeatChildren = repeat;

  // Snippet node anywhere in the subtree (excluding the node itself).
  let hasSnippetChild = false;
  const stack = [...(node.children || [])];
  while (stack.length) {
    const n = stack.pop();
    if (hasSnippet(n)) { hasSnippetChild = true; break; }
    for (const child of n.children || []) stack.push(child);
  }
  node.__hasSnippetChild = hasSnippetChild;
}

// ============================================================================
// PHASE 2: SPLIT
// ============================================================================

function stripFlags(node) {
  const { __repeatChildren, __hasSnippetChild, ...rest } = node;
  if (rest.children?.length) {
    rest.children = rest.children.map(stripFlags);
  }
  return rest;
}

function emitChunk(node, ctx, reason) {
  const id = `chunk-${ctx.counter++}`;
  const slug = slugify(node.name);
  const fileName = `${slug}-${id}.json`;

  writeFileSync(
    resolve(ctx.outDir, fileName),
    JSON.stringify({ screen: ctx.screen, root: stripFlags(node) }, null, 2),
  );

  ctx.chunks.push({ file: fileName, name: node.name, reason });

  return {
    name: node.name,
    type: 'CHUNK_REF',
    chunkRef: fileName,
    figmaNodeId: node.id,
  };
}

function splitNode(node, ctx, isRoot) {
  if (!isRoot) {
    if (hasSnippet(node)) return stripFlags(node);
    if (isLeaf(node)) return stripFlags(node);
    if (isNoise(node)) {
      if (node.children?.length) {
        return {
          ...stripFlags(node),
          children: node.children.map((c) => splitNode(c, ctx, false)),
        };
      }
      return stripFlags(node);
    }

    if (node.__repeatChildren) {
      return emitChunk(node, ctx, 'repeat');
    }

    if (node.__hasSnippetChild && sizeOf(node) <= ctx.threshold) {
      return emitChunk(node, ctx, 'size');
    }
  }

  if (node.children?.length) {
    return {
      ...stripFlags(node),
      children: node.children.map((c) => splitNode(c, ctx, false)),
    };
  }
  return stripFlags(node);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

export function splitManifest(manifest, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const outDir = options.outDir ?? process.cwd();

  const totalSize = sizeOf(manifest.root);
  if (totalSize <= threshold) {
    return { manifest, chunks: [], totalSize, split: false };
  }

  // Clear stale chunk files from previous runs.
  if (existsSync(outDir)) {
    for (const f of readdirSync(outDir)) {
      if (f.endsWith('.json')) rmSync(resolve(outDir, f), { force: true });
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  // Phase 1: mark.
  markNode(manifest.root);

  // Phase 2: split.
  const ctx = {
    screen: manifest.screen,
    threshold,
    outDir,
    counter: 1,
    chunks: [],
  };

  const newRoot = splitNode(manifest.root, ctx, true);

  if (ctx.chunks.length === 0) {
    return { manifest, chunks: [], totalSize, split: false };
  }

  return {
    manifest: { screen: manifest.screen, root: newRoot, chunks: ctx.chunks },
    chunks: ctx.chunks,
    totalSize,
    split: true,
  };
}
