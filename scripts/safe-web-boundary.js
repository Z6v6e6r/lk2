import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';

/**
 * Second delivery class of the standard Timeweb Web route: bounded tuning of already-installed Web
 * modules.
 *
 * `presentation-boundary.js` proves copy, ARIA labels and bounded styling syntactically. This module
 * covers a different, deliberately smaller thing: a reviewed module may be re-delivered when only
 * *literal values* change — a dimension cap, a quality factor, a display string, a numeric limit —
 * while its syntax stays frozen. Every dependency declaration is judged separately by an explicit
 * allowlist rule, and, for a shared surface file, only the named functions may change at all.
 *
 * The boundary is structural, so it cannot be satisfied by an added capability:
 *
 * - the printed syntax tree, with literal values replaced by placeholders, must be identical; a new
 *   statement, call, property, helper, alias, control-flow branch or API use changes it and fails;
 * - dependency declarations may only be added, removed or edited when their target is itself an
 *   allowlisted module, so a new dependency, SDK entry or network client never rides along;
 * - a module that is absent at the installed baseline is a first landing and keeps the
 *   critical/manual component release route.
 *
 * What this does not prove: a changed literal value is trusted by construction (that is the point of
 * the class), so a review still has to agree with the constant being changed, and a module's existing
 * capabilities are not re-argued on every delivery. The class therefore stays bound to a tiny
 * reviewed allowlist, the full Web quality contour, the complete main-push CI and an enrolled owner
 * who observes every receipt. Adding an allowlist entry or relaxing an invariant here is itself a
 * reviewable change of this file that reaches the operator only through a new controller enrollment.
 * It never widens the backend, contracts, migrations, authentication, payment or deployment
 * boundaries.
 */
export const SAFE_WEB_MODULES = new Map([
  // The photo re-encode: its decode, canvas and encode structure is reviewed; its dimension cap and
  // quality factor are the tunable literals.
  ['apps/web/src/chats-ui/chat-image-webp.ts', { functions: [] }],
  // In the application shell, literals inside the attachment-upload command pair may change. That
  // path does call the API gateway (`issueConversationMediaUpload`,
  // `finalizeConversationMediaUpload`), which is exactly why it is an explicit, named,
  // owner-reviewed entry; the remaining ~3000 lines of the shell stay structurally identical.
  ['apps/web/src/App.tsx', { functions: ['handleAttachChatFiles', 'uploadChatAttachment'] }],
]);

const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const LITERAL_PLACEHOLDER = 'padlhub-literal';

/** Test files of an allowlisted module ship no runtime and stay outside the source comparison. */
export function isSafeWebPath(path) {
  if (TEST_FILE.test(path)) return SAFE_WEB_MODULES.has(path.replace(/\.test\.(ts|tsx)$/, '.$1'));
  return SAFE_WEB_MODULES.has(path);
}

function parse(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // The printer drops parser-discarded regions, so a source that does not parse cleanly must never
  // be compared: an accepted set larger than the parseable set is not a boundary.
  if (file.parseDiagnostics.length > 0) throw new Error('SAFE_WEB_SYNTAX_INVALID');
  return file;
}

const printer = ts.createPrinter({ removeComments: true });

function moduleSpecifier(node) {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

function dependencyDeclarations(file) {
  return file.statements.filter(
    (node) =>
      ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier),
  );
}

/** A relative specifier resolves to an allowlisted module only if it maps onto one of its sources. */
function resolvesToAllowlist(importerPath, specifier) {
  if (!specifier || !specifier.startsWith('.')) return false;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
  return [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.jsx$/, '.tsx'),
    base.replace(/\.mjs$/, '.ts'),
  ].some((candidate) => SAFE_WEB_MODULES.has(candidate));
}

/**
 * Dependency declarations may move only inside the allowlist: an added, removed or edited
 * declaration must resolve to another allowlisted module. Everything else keeps the full contour.
 */
function importsStayInAllowlist(importerPath, before, after) {
  const describe = (file) =>
    dependencyDeclarations(file).map((node) => ({
      specifier: moduleSpecifier(node),
      text: printer.printNode(ts.EmitHint.Unspecified, node, file),
    }));
  const previous = describe(before);
  const next = describe(after);
  const missing = (from, other) => {
    const remaining = other.map((item) => item.text);
    return from.filter((item) => {
      const index = remaining.indexOf(item.text);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
  };
  return [...missing(previous, next), ...missing(next, previous)].every((item) =>
    resolvesToAllowlist(importerPath, item.specifier),
  );
}

function isLiteral(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

/**
 * The printable structure of the file with every literal value replaced by one placeholder and every
 * dependency declaration by an empty statement. Function bodies outside `functions` keep their
 * literals, so only the named functions become tunable.
 */
function structuralSignature(path, source, functions) {
  const file = parse(path, source);
  const everythingIsTunable = functions.length === 0;
  const result = ts.transform(file, [
    (context) => {
      const visit = (node, tunable) => {
        if (ts.isFunctionDeclaration(node) && node.name && functions.includes(node.name.text)) {
          tunable = true;
        }
        if (
          ts.isImportDeclaration(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier)
        ) {
          return ts.factory.createEmptyStatement();
        }
        if (tunable && isLiteral(node)) {
          return ts.factory.createStringLiteral(LITERAL_PLACEHOLDER);
        }
        return ts.visitEachChild(node, (child) => visit(child, tunable), context);
      };
      return (root) => ts.visitNode(root, (node) => visit(node, everythingIsTunable));
    },
  ]);
  try {
    return printer.printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
}

/** Verifies one revision of an allowlisted module against its previous revision. */
export function verifySafeWebSources(path, before, after) {
  const entry = SAFE_WEB_MODULES.get(path);
  if (!entry || typeof before !== 'string' || typeof after !== 'string') return false;
  try {
    const beforeFile = parse(path, before);
    const afterFile = parse(path, after);
    if (!importsStayInAllowlist(path, beforeFile, afterFile)) return false;
    return (
      structuralSignature(path, before, entry.functions) ===
      structuralSignature(path, after, entry.functions)
    );
  } catch {
    return false;
  }
}

function readAt(sha, path) {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function readableCommit(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function verifySafeWebRange(paths, base, head) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) return false;
  if (!readableCommit(base) || !readableCommit(head)) return false;
  return paths.filter(isSafeWebPath).every((path) => {
    if (TEST_FILE.test(path)) return true;
    const after = readAt(head, path);
    const before = readAt(base, path);
    // A module absent at the installed baseline is a first landing: it keeps the critical/manual
    // component release route. An unreadable blob is a bad request, and both fail closed.
    if (after === undefined || before === undefined) return false;
    return verifySafeWebSources(path, before, after);
  });
}
