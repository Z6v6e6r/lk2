import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import postcss from 'postcss';

// Existing render surfaces, not directory/name heuristics. Command expressions and imports
// are immutable in this profile. Adding an area changes CI policy and requires full review.
export const PRESENTATION_SURFACES = new Map([
  ['apps/web/src/RecommendationGridCard.tsx', null],
  ['apps/web/src/TournamentSummaryCard.tsx', null],
  ['apps/web/src/GameCard.tsx', null],
  ['apps/web/src/SummaryParticipants.tsx', null],
  ['apps/web/src/GameTypeBadge.tsx', null],
  ['apps/web/src/ActivityCardIcons.tsx', null],
  ['apps/web/src/ProfilePage.tsx', ['ProfileSubscriptions']],
]);

export function isPresentationPath(path) {
  return (
    path === 'apps/web/src/styles.css' ||
    PRESENTATION_SURFACES.has(path) ||
    PRESENTATION_SURFACES.has(path.replace(/\.test\.tsx$/, '.tsx'))
  );
}

// Deliberately a small syntactic rule: copy and literal styling/accessibility attributes.
// No attempt to prove arbitrary JS safe. A handler, href, price, entitlement, import,
// conditional or dependency change falls back to the normal/full source contour.
export function presentationFingerprint(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length) throw new Error('Invalid presentation syntax');
  const functions = PRESENTATION_SURFACES.get(path);
  const edits = [];
  function visit(node, allowed) {
    if (functions && ts.isFunctionDeclaration(node)) {
      allowed = functions.includes(node.name?.text);
    }
    if (allowed && ts.isJsxText(node)) edits.push([node.pos, node.end, 'COPY']);
    if (
      allowed &&
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      ['aria-label', 'title'].includes(node.name.getText(file))
    ) {
      edits.push([node.initializer.getStart(file), node.initializer.end, '"PRESENTATION"']);
    }
    ts.forEachChild(node, (child) => visit(child, allowed));
  }
  visit(file, functions === null);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  // Printer ignores formatting/trivia; executable syntax and JSX structure stay exact.
  const normalized = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return ts.createPrinter({ removeComments: true }).printFile(normalized);
}

function styleClasses(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const classes = [];
  function visit(node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === 'className' &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    )
      classes.push(node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return classes;
}

export function verifyPresentationStyles(before, after) {
  const allowedProperties = /^(?:gap|padding|border-radius|background-color)$/;
  function rules(source) {
    const result = new Map();
    const root = postcss.parse(source);
    // Treat non-rule nodes as immutable; no @import, media rules or new network inputs.
    root.nodes.forEach((node, index) =>
      result.set(
        node.type === 'rule' ? `rule:${node.selector}:${index}` : `other:${index}`,
        node.toString(),
      ),
    );
    return result;
  }
  try {
    const old = rules(before),
      next = rules(after);
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      if (old.get(key) === next.get(key)) continue;
      if (!key.startsWith('rule:') || !next.has(key)) return false;
      const rule = postcss.parse(next.get(key)).first;
      if (
        !rule.selector
          .split(',')
          .every((selector) => /^\.presentation-[a-z0-9-]+$/.test(selector.trim()))
      )
        return false;
      const oldRule = old.has(key) ? postcss.parse(old.get(key)).first : null;
      const declarations = (node) =>
        new Map(
          (node?.nodes ?? [])
            .filter((item) => item.type !== 'comment')
            .map((item) => [item.prop, item.toString()]),
        );
      const previous = declarations(oldRule),
        current = declarations(rule);
      for (const property of new Set([...previous.keys(), ...current.keys()])) {
        if (previous.get(property) === current.get(property)) continue;
        const value =
          current.get(property)?.split(':').slice(1).join(':').replace(/;$/, '').trim() ?? '';
        const bounded =
          property === 'background-color'
            ? /^#[a-f0-9]{6}$/i.test(value)
            : value.split(/\s+/).length <= 4 &&
              value
                .split(/\s+/)
                .every(
                  (part) => /^(?:0|[0-9]+(?:\.[0-9]+)?px)$/.test(part) && parseFloat(part) <= 64,
                );
        if (
          !bounded ||
          !allowedProperties.test(property) ||
          /(?:^|[ :])-\d|(?:font-size|line-height):\s*0(?:[^.\d]|$)/.test(
            current.get(property) ?? '',
          ) ||
          /url\(|var\(|expression|!important|transparent/i.test(current.get(property) ?? '')
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function verifyPresentationSources(path, before, after) {
  if (!PRESENTATION_SURFACES.has(path)) return false;
  try {
    const oldClasses = styleClasses(before, path),
      newClasses = styleClasses(after, path);
    if (oldClasses.length !== newClasses.length) return false;
    for (let i = 0; i < oldClasses.length; i += 1) {
      if (oldClasses[i] === newClasses[i]) continue;
      if (
        ![
          'tournament-summary-card__organizer',
          'game-card__meta',
          'activity-card-metadata-row',
          'profile-inline-icon',
        ].includes(oldClasses[i])
      )
        return false;
      // Existing classes cannot be removed or replaced with hiding/command utilities.
      const oldTokens = oldClasses[i].split(/\s+/),
        newTokens = newClasses[i].split(/\s+/);
      if (
        oldTokens.some((token) => !newTokens.includes(token)) ||
        newTokens.some(
          (token) => !oldTokens.includes(token) && !/^presentation-[a-z0-9-]+$/.test(token),
        )
      )
        return false;
      after = after.replace(`className="${newClasses[i]}"`, `className="${oldClasses[i]}"`);
    }
    return presentationFingerprint(path, before) === presentationFingerprint(path, after);
  } catch {
    return false;
  }
}

export function verifyPresentationRange(paths, base, head) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) return false;
  return paths.filter(isPresentationPath).every((path) => {
    if (path.endsWith('.test.tsx')) return true;
    try {
      const read = (sha) =>
        execFileSync('git', ['show', `${sha}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      return path.endsWith('.css')
        ? verifyPresentationStyles(read(base), read(head))
        : verifyPresentationSources(path, read(base), read(head));
    } catch {
      return false;
    }
  });
}
