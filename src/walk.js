/**
 * Walks a raw Figma node tree and produces a manifest node.
 * All boundVariables values are resolved against the token map.
 *
 * Matching strategies (for slots, childrenFrom):
 *   - by: 'layer'     → match by mainComponent.name or node.name (default)
 *   - by: 'component' → match by mainComponent.variantName prefix (before first comma)
 *   - exclude: string → reject if mainComponent.variantName contains this string
 */

const AIR_PREFIX = 'air-';

// ============================================================================
// TOKEN HELPERS
// ============================================================================

function stripCollection(name) {
  return name.replace(/\s*\[[^\]]+\]\s*$/, '');
}

function isSkippable(varName) {
  return (
    varName.startsWith('paragraphspacing/') ||
    varName.startsWith('paragraphindent/')
  );
}

function resolveToken(rawName, tokenMap) {
  const clean = stripCollection(rawName);
  if (isSkippable(clean)) return null;
  const mapped = tokenMap[clean];
  return mapped || `UNMAPPED: ${clean}`;
}

function transformBoundVariables(boundVars, tokenMap) {
  if (!boundVars) return undefined;
  const out = {};
  for (const [prop, val] of Object.entries(boundVars)) {
    const r = resolveToken(val, tokenMap);
    if (r !== null) out[prop] = r;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Maps CSS property names to Figma boundVariables keys.
function mapCssPropToTokenKey(cssProp) {
  const map = {
    // Colors (fills)
    'background': 'fills.0',
    'background-color': 'fills.0',
    'color': 'fills.0',
    'caret-color': 'fills.0',
    'text-decoration-color': 'fills.0',

    // Borders (strokes + widths + radii)
    'border-color': 'strokes.0',
    'border-top-color': 'strokes.0',
    'border-right-color': 'strokes.0',
    'border-bottom-color': 'strokes.0',
    'border-left-color': 'strokes.0',
    'border-width': 'strokeTopWeight',
    'border-top-width': 'strokeTopWeight',
    'border-right-width': 'strokeRightWeight',
    'border-bottom-width': 'strokeBottomWeight',
    'border-left-width': 'strokeLeftWeight',
    'border-top-left-radius': 'topLeftRadius',
    'border-top-right-radius': 'topRightRadius',
    'border-bottom-left-radius': 'bottomLeftRadius',
    'border-bottom-right-radius': 'bottomRightRadius',

    // Spacing
    'padding': 'paddingTop', // fallback
    'padding-top': 'paddingTop',
    'padding-right': 'paddingRight',
    'padding-bottom': 'paddingBottom',
    'padding-left': 'paddingLeft',
    'gap': 'itemSpacing',
    'row-gap': 'itemSpacing',
    'column-gap': 'itemSpacing',

    // Typography
    'font-size': 'fontSize.0',
    'font-family': 'fontFamily.0',
    'font-weight': 'fontWeight.0',
    'letter-spacing': 'letterSpacing.0',
    'line-height': 'lineHeight.0',

    // Shadows
    'box-shadow': 'effects.0',
  };
  return map[cssProp] || null;
}

// ============================================================================
// DEDUP
// ============================================================================

function hashNode(node) {
  return JSON.stringify(node, (key, value) => {
    if (key === 'id' || key === 'position' || key === '$repeat') {
      return undefined;
    }
    return value;
  });
}

function dedupeSiblings(children) {
  const result = [];
  let prevHash = null;
  let prevNode = null;

  for (const child of children) {
    const h = hashNode(child);
    
    // Collapse only if the element matches the PREVIOUS one
    if (prevNode && h === prevHash) {
      if (prevNode.$repeat) prevNode.$repeat.count += 1;
      else prevNode.$repeat = { count: 2 };
    } else {
      result.push(child);
      prevHash = h;
      prevNode = child;
    }
  }
  
  // Collapse only adjacent repeating unmapped components
  const finalResult = [];
  let currentGroup = [];
  
  for (const child of result) {
    const name = child.type === 'INSTANCE' && !child.$snippet ? child.mainComponent?.name : null;
    
    if (name && currentGroup.length > 0 && currentGroup[0].mainComponent?.name === name) {
      currentGroup.push(child);
    } else {
      if (currentGroup.length >= 3) {
        // Keep REPEAT_KEEP items (1 or 2) and add $total
        finalResult.push(...currentGroup.slice(0, REPEAT_KEEP));
        finalResult.push({ $total: currentGroup.length });
      } else {
        finalResult.push(...currentGroup);
      }
      currentGroup = [child];
    }
  }
  
  // Flush the last group
  if (currentGroup.length >= 3) {
    finalResult.push(...currentGroup.slice(0, REPEAT_KEEP));
    finalResult.push({ $total: currentGroup.length });
  } else {
    finalResult.push(...currentGroup);
  }

  return finalResult;
}

const REPEAT_KEEP = 1;

// ============================================================================
// MATCH HELPERS
// ============================================================================

function nodeMatches(node, rule) {
  const by = rule.by || 'layer';
  let matches = false;

  if (by === 'layer') {
    const match = Array.isArray(rule.match) ? rule.match : [rule.match];
    matches = node.mainComponent?.name 
      ? match.includes(node.mainComponent.name) || match.includes(node.name)
      : match.includes(node.name);

  } else if (by === 'component') {
    const mc = node.mainComponent?.variantName || '';
    const primary = mc.split(',')[0].trim();
    const match = Array.isArray(rule.match) ? rule.match : [rule.match];
    matches = match.some(m => primary === m || mc.startsWith(m + ','));
  } else if (by === 'icon') {
    matches = isIconNode(node);
  }

  if (matches && rule.exclude) {
    const name = node.mainComponent?.name || '';
    const variant = node.mainComponent?.variantName || '';
    if (name.includes(rule.exclude) || variant.includes(rule.exclude)) {
      return false;
    }
  }

  return matches;
}

function findFirst(node, rule) {
  if (nodeMatches(node, rule)) return node;
  for (const child of node.children || []) {
    const found = findFirst(child, rule);
    if (found) return found;
  }
  return null;
}

function findAll(node, rule, results = []) {
  if (nodeMatches(node, rule)) results.push(node);
  for (const child of node.children || []) {
    findAll(child, rule, results);
  }
  return results;
}

function isIconNode(node) {
  if (node.type !== 'INSTANCE') return false;
  const mc = node.mainComponent?.name || '';
  if (!mc.includes('/')) return false;
  const children = node.children || [];
  if (children.length === 0) return true;
  return children.every(c => c.type === 'VECTOR' || c.type === 'RECTANGLE');
}

/**
 * Finds icons in the tree. Does NOT descend into nested INSTANCE nodes
 * (unless it's the root node), because their internal icons belong to them.
 */
function findIcons(node, isRoot = true, results = []) {
  if (isIconNode(node)) {
    results.push(node);
    return results;
  }
  if (!isRoot && node.type === 'INSTANCE') {
    return results;
  }
  for (const child of node.children || []) {
    findIcons(child, false, results);
  }
  return results;
}

// ============================================================================
// CODE MAP HELPERS
// ============================================================================

function toVariablePrefix(codeName) {
  const withoutAir = codeName.startsWith(AIR_PREFIX)
    ? codeName.slice(AIR_PREFIX.length)
    : codeName;
  return withoutAir
    .split('-')
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

function toVariableName(codeName, codeProp, index) {
  const base = toVariablePrefix(codeName) + codeProp[0].toUpperCase() + codeProp.slice(1);
  return index !== undefined ? `${base}_${index}` : base;
}

function findMapEntry(node, codeMap) {
  if (!codeMap?.components) return null;

  const componentName = node.mainComponent?.name;
  if (!componentName) return null;

  return codeMap.components.find((c) => {
    const figmaNames = Array.isArray(c.figma) ? c.figma : [c.figma];
    return figmaNames.includes(componentName);
  }) || null;
}

function parseVariants(mainComponentName) {
  const out = {};
  for (const segment of mainComponentName.split(',')) {
    const [key, value] = segment.split('=').map((s) => s.trim());
    if (key && value) out[key] = value;
  }
  return out;
}

function extractProps(variantName, entry) {
  const result = {};
  const figmaVariants = parseVariants(variantName);
  for (const [figmaProp, codeProp] of Object.entries(entry.props || {})) {
    const figmaValue = figmaVariants[figmaProp];
    if (figmaValue === undefined) continue;
    const valueMap = entry.variants?.[figmaProp];
    result[codeProp] = valueMap?.[figmaValue] ?? figmaValue;
  }
  return result;
}

// ============================================================================
// INSTANCE COUNTING (pre-pass)
// ============================================================================

function countInstances(node, codeMap, counts = new Map()) {
  if (node.type === 'INSTANCE' && node.mainComponent?.name) {
    const entry = findMapEntry(node, codeMap);
    if (entry) {
      counts.set(entry.code, (counts.get(entry.code) || 0) + 1);
    }
  }
  for (const child of node.children || []) {
    countInstances(child, codeMap, counts);
  }
  return counts;
}

// ============================================================================
// CHILDREN FROM
// ============================================================================

function resolveFieldDescriptor(sourceNode, descriptor, codeMap) {
  if (!descriptor) return null;

  if (descriptor.from === 'layer') {
    if (descriptor.index !== undefined) {
      const items = findAll(sourceNode, { match: descriptor.name, by: 'layer' });
      let idx = descriptor.index;
      if (idx < 0) idx = items.length + idx;
      const item = items[idx];
      if (!item || item.type !== 'TEXT') return null;
      return item.text ?? null;
    }
    
    const layer = findFirst(sourceNode, { match: descriptor.name, by: 'layer' });
    if (!layer || layer.type !== 'TEXT') return null;
    return layer.text ?? null;
  }

  if (descriptor.from === 'child') {
    const child = findFirst(sourceNode, {
      match: descriptor.match,
      by: descriptor.by || 'layer',
    });
    if (!child) return null;

    if (descriptor.asBoolean) return true;
    if (descriptor.asString) return descriptor.asString;
    if (descriptor.asValue) return descriptor.asValue;

    if (descriptor.map) {
      const result = resolveChildrenFromMap(child, descriptor.map, codeMap);
      if (!result) return null;
      if (descriptor.extract) return result[descriptor.extract];
      return result;
    }

    if (child.mainComponent?.name) {
      const figmaIconName = child.mainComponent.name.split(',')[0].trim();
      const normalized = figmaIconName.includes('/')
        ? figmaIconName.split('/').pop()
        : figmaIconName;
      return codeMap?.icons?.[normalized] ?? 'layout';
    }
    return null;
  }

  if (descriptor.from === 'children') {
    const items = findAll(sourceNode, {
      match: descriptor.match,
      by: descriptor.by || 'layer',
    });

    if (descriptor.index !== undefined) {
      let idx = descriptor.index;
      if (idx < 0) idx = items.length + idx;
      const item = items[idx];
      if (!item) return null;
      return descriptor.map 
        ? resolveChildrenFromMap(item, descriptor.map, codeMap) 
        : (item.text ?? null);
    }
    
    const max = descriptor.maxItems;
    const slicedItems = max !== undefined ? items.slice(0, max) : items;
    
    const result = slicedItems.map((item) =>
      descriptor.map
        ? resolveChildrenFromMap(item, descriptor.map, codeMap)
        : {}
    );
    if (max !== undefined && items.length > max) result.push({ $total: items.length });
    return result;
  }

  if (descriptor.from === 'icon') {
    const icons = findIcons(sourceNode, true);
    if (icons.length === 0) return null;

    let idx = descriptor.index ?? 0;
    
    if (descriptor.index === -1 && icons.length === 1) {
      return null;
    }

    if (idx < 0) idx = icons.length + idx;

    const iconNode = icons[idx];
    if (!iconNode || !iconNode.mainComponent) return null;

    const rawName = (iconNode.mainComponent.name || '').split(',')[0].trim();
    const normalized = rawName.includes('/') ? rawName.split('/').pop() : rawName;
    return codeMap?.icons?.[normalized] ?? 'layout';
  }

  if (descriptor.from === 'variant') {
    const mc = sourceNode.mainComponent?.variantName || sourceNode.mainComponent?.name || '';
    const parts = mc.split(',').map(s => s.trim());
    
    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key && key.trim() === descriptor.name) {
        const rawValue = value.trim();
        
        if (descriptor.variants) {
          if (descriptor.variants[rawValue] !== undefined) {
            return descriptor.variants[rawValue];
          }
          if (descriptor.default !== undefined) {
            return descriptor.default;
          }
        }
        
        return rawValue.toLowerCase();
      }
    }
    return descriptor.default !== undefined ? descriptor.default : null;
  }

  if (descriptor.from === 'componentProp') {
    const props = sourceNode.componentProps || {};
    const targetKey = Object.keys(props).find(k => k.split('#')[0].trim() === descriptor.name);
    return targetKey ? props[targetKey] : false;
  }

  return null;
}

function resolveChildrenFromMap(sourceNode, map, codeMap) {
  if (!map) return null;
  const result = {};
  for (const [key, descriptor] of Object.entries(map)) {
    const val = resolveFieldDescriptor(sourceNode, descriptor, codeMap);
    if (val !== null && val !== undefined) {
      result[key] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function applyChildrenFrom(parentNode, entry, codeMap) {
  const result = {};
  if (!entry.childrenFrom) return result;

  for (const [propName, rule] of Object.entries(entry.childrenFrom)) {
    if (!rule) continue;

    if (!rule.collect) {
      result[propName] = resolveFieldDescriptor(parentNode, rule, codeMap);
      continue;
    }

    if (rule.collect === 'single') {
      if (rule.match) {
        const matchedChild = findFirst(parentNode, { match: rule.match, by: rule.by || 'layer' });
        if (matchedChild && rule.map) {
          result[propName] = resolveChildrenFromMap(matchedChild, rule.map, codeMap);
        } else if (matchedChild) {
          result[propName] = matchedChild;
        }
      } else if (rule.map) {
        result[propName] = resolveChildrenFromMap(parentNode, rule.map, codeMap);
      } else {
        result[propName] = resolveFieldDescriptor(parentNode, rule, codeMap);
      }
      continue;
    }

    if (rule.collect === 'array') {
      if (rule.match) {
        const items = findAll(parentNode, {
          match: rule.match,
          by: rule.by || 'layer',
        });
        
        const max = rule.maxItems; 
        const slicedItems = max !== undefined ? items.slice(0, max) : items;

        result[propName] = slicedItems.map((item) =>
          rule.map ? resolveChildrenFromMap(item, rule.map, codeMap) : {}
        );
        
        if (max !== undefined && items.length > max) {
          result[`$${propName}_total`] = items.length;
        }
      } else {
        result[propName] = rule.map
          ? [resolveChildrenFromMap(parentNode, rule.map, codeMap)]
          : [];
      }
    }
  }

  return result;
}

// ============================================================================
// SLOTS + SNIPPET
// ============================================================================

function injectAttribute(snippet, attr) {
  return snippet.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)(\s)/, `$1 ${attr}$2`);
}

function renderSlots(snippet, parentNode, entry, codeMap, collectedInputs, counts, instanceCounters) {
  if (!entry.slots) return snippet;

  let result = snippet;

  for (const [slotName, slotRule] of Object.entries(entry.slots)) {
    const placeholder = `{{slot:${slotName}}}`;

    const child = findFirst(parentNode, {
      match: slotRule.match,
      by: slotRule.by || 'layer',
      exclude: slotRule.exclude,
    });

    if (!child) {
      result = result.replace(placeholder, '');
      continue;
    }

    const childEntry = findMapEntry(child, codeMap);
    if (!childEntry) {
      result = result.replace(placeholder, '');
      continue;
    }

    const total = counts.get(childEntry.code) || 1;
    let index;
    if (total > 1) {
      const current = (instanceCounters.get(childEntry.code) || 0) + 1;
      instanceCounters.set(childEntry.code, current);
      index = current;
    }

    const childRendered = renderComponent(child, childEntry, codeMap, index, counts, instanceCounters);
    let childSnippet = childRendered.$snippet;
    if (slotRule.slotAttr) {
      childSnippet = injectAttribute(childSnippet, slotRule.slotAttr);
    }

    result = result.replace(placeholder, childSnippet);
    Object.assign(collectedInputs, childRendered.$inputs);
  }

  return result;
}

function renderSnippet(entry, props, childrenFrom, parentNode, codeMap, index, counts, instanceCounters) {
  const inputs = {};
  let snippet = entry.snippet || '';

  for (const [key, value] of Object.entries(childrenFrom)) {
    if (key.startsWith('$')) {
      inputs[key] = value;
      continue;
    }
    
    // If the value is null or undefined, remove the attribute entirely.
    if (value === null || value === undefined) {
      const attrRegex = new RegExp(`\\s*\\[[a-zA-Z0-9]+\\]="\\{\\{${key}\\}\\}"`, 'g');
      snippet = snippet.replace(attrRegex, '');
      continue;
    }

    const placeholder = `{{${key}}}`;
    if (snippet.includes(placeholder)) {
      const varName = toVariableName(entry.code, key, index);
      inputs[varName] = value;
      snippet = snippet.split(placeholder).join(varName);
    }
  }

  for (const [figmaProp, codeProp] of Object.entries(entry.props || {})) {
    const placeholder = `{{${figmaProp}}}`;
    if (snippet.includes(placeholder) && props[codeProp] !== undefined) {
      const varName = toVariableName(entry.code, codeProp, index);
      inputs[varName] = props[codeProp];
      snippet = snippet.split(placeholder).join(varName);
    }
  }

  snippet = renderSlots(snippet, parentNode, entry, codeMap, inputs, counts, instanceCounters);

  return { snippet, inputs };
}

function renderComponent(node, entry, codeMap, index, counts, instanceCounters) {
  const variantName = node.mainComponent?.variantName || '';
  const props = extractProps(variantName, entry);
  const childrenFrom = applyChildrenFrom(node, entry, codeMap);
  const { snippet, inputs } = renderSnippet(
    entry,
    props,
    childrenFrom,
    node,
    codeMap,
    index,
    counts,
    instanceCounters
  );
  return { $snippet: snippet, $inputs: inputs };
}

// ============================================================================
// TRANSFORM NODE
// ============================================================================

export function transformNode(node, tokenMap, codeMap, counts, instanceCounters) {
  // Initialize on first call (from transform.js)
  if (!counts) {
    counts = countInstances(node, codeMap);
    instanceCounters = new Map();
  }

  if (node.type === 'VECTOR') {
    const out = { name: node.name, type: node.type };
    const tokens = transformBoundVariables(node.boundVariables, tokenMap);
    if (tokens) out.tokens = tokens;
    return out;
  }

  if (node.type === 'INSTANCE' && node.mainComponent?.name) {
    const entry = findMapEntry(node, codeMap);
    if (entry) {
      const total = counts.get(entry.code) || 1;
      let index;
      if (total > 1) {
        const current = (instanceCounters.get(entry.code) || 0) + 1;
        instanceCounters.set(entry.code, current);
        index = current;
      }

      const { $snippet, $inputs } = renderComponent(node, entry, codeMap, index, counts, instanceCounters);
      const out = { name: node.name, type: node.type, $snippet };
      if (Object.keys($inputs).length > 0) out.$inputs = $inputs;

      // Preserve CSS for the snippet (layout, sizes)
      if (node.css) {
        const cssOut = {};
        const tokens = transformBoundVariables(node.boundVariables, tokenMap) || {};
        
        for (const [prop, value] of Object.entries(node.css)) {
          const tokenKey = mapCssPropToTokenKey(prop);
          if (tokenKey && tokens[tokenKey]) {
            const tokenValue = tokens[tokenKey];
            if (typeof tokenValue === 'string' && tokenValue.startsWith('--lib-')) {
              cssOut[prop] = `var(${tokenValue})`;
            } else if (typeof tokenValue === 'string' && tokenValue.startsWith('UNMAPPED:')) {
              cssOut[prop] = `${tokenValue} | original: ${value}`;
            } else {
              cssOut[prop] = value;
            }
          } else {
            cssOut[prop] = value;
          }
        }
        out.css = cssOut;
      }

      return out;
    }
  }

  const out = {};
  if (node.name !== undefined) out.name = node.name;
  if (node.type !== undefined) out.type = node.type;

  if (node.css) {
    const cssOut = {};
    const tokens = transformBoundVariables(node.boundVariables, tokenMap) || {};

    for (const [prop, value] of Object.entries(node.css)) {
      if (prop === 'padding') {
        const sides = {
          'padding-top': 'paddingTop',
          'padding-right': 'paddingRight',
          'padding-bottom': 'paddingBottom',
          'padding-left': 'paddingLeft',
        };
        
        // Only split if ALL sides have resolved --lib-* tokens (no UNMAPPED)
        const allResolved = Object.values(sides).every(
          (k) => tokens[k] && tokens[k].startsWith('--lib-')
        );

        if (allResolved) {
          for (const [cssSide, tokenKey] of Object.entries(sides)) {
            cssOut[cssSide] = `var(${tokens[tokenKey]})`;
          }
        } else {
          // Collect unique UNMAPPED token names
          const unmappedNames = Object.values(sides)
            .map((tokenKey) => tokens[tokenKey])
            .filter((v) => v && v.startsWith('UNMAPPED:'))
            .map((v) => v.replace('UNMAPPED: ', ''));
          
          const uniqueNames = [...new Set(unmappedNames)];
          
          if (uniqueNames.length > 0) {
            cssOut[prop] = `UNMAPPED: ${uniqueNames.join(', ')} | original: ${value}`;
          } else {
            cssOut[prop] = value;
          }
        }
        continue;
      }

      const tokenKey = mapCssPropToTokenKey(prop);

            if (prop === 'border-radius') {
        const corners = {
          'border-top-left-radius': 'topLeftRadius',
          'border-top-right-radius': 'topRightRadius',
          'border-bottom-right-radius': 'bottomRightRadius',
          'border-bottom-left-radius': 'bottomLeftRadius',
        };
        
        const allResolved = Object.values(corners).every(
          (k) => tokens[k] && tokens[k].startsWith('--lib-')
        );

        if (allResolved) {
          for (const [cssCorner, tokenKey] of Object.entries(corners)) {
            cssOut[cssCorner] = `var(${tokens[tokenKey]})`;
          }
        } else {
          const unmappedNames = Object.values(corners)
            .map((tokenKey) => tokens[tokenKey])
            .filter((v) => v && v.startsWith('UNMAPPED:'))
            .map((v) => v.replace('UNMAPPED: ', ''));
          
          const uniqueNames = [...new Set(unmappedNames)];
          
          if (uniqueNames.length > 0) {
            cssOut[prop] = `UNMAPPED: ${uniqueNames.join(', ')} | original: ${value}`;
          } else {
            cssOut[prop] = value;
          }
        }
        continue;
      }
      
      if (tokenKey && tokens[tokenKey]) {
        const tokenValue = tokens[tokenKey];
        if (typeof tokenValue === 'string' && tokenValue.startsWith('--lib-')) {
          cssOut[prop] = `var(${tokenValue})`;
        } else if (typeof tokenValue === 'string' && tokenValue.startsWith('UNMAPPED:')) {
          cssOut[prop] = `${tokenValue} | original: ${value}`;
        } else {
          cssOut[prop] = value;
        }
      } else {
        // No token for this property: keep the raw CSS value
        cssOut[prop] = value;
      }
    }

    out.css = cssOut;
  }
  if (node.mainComponent?.name) {
    out.mainComponent = { name: node.mainComponent.name };
  }

  if (node.text !== undefined) out.text = node.text;

  if (node.children?.length) {
    const transformed = node.children.map((child) =>
      transformNode(child, tokenMap, codeMap, counts, instanceCounters)
    );
    out.children = dedupeSiblings(transformed);
  }

  return out;
}

// ============================================================================
// STATS
// ============================================================================

export function collectStats(node) {
  const stats = { total: 0, mapped: 0, unmapped: 0, unmappedNames: new Set() };

  function walk(n) {
    if (n.tokens) {
      for (const val of Object.values(n.tokens)) {
        stats.total++;
        if (val.startsWith('UNMAPPED: ')) {
          stats.unmapped++;
          stats.unmappedNames.add(val.replace('UNMAPPED: ', ''));
        } else {
          stats.mapped++;
        }
      }
    }
    n.children?.forEach(walk);
  }

  walk(node);
  return stats;
}
