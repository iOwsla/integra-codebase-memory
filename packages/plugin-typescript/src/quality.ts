import { hash } from "@codememory/shared";
import ts from "typescript";

/** Exact body text, with line endings normalized. No semantic-equivalence claim. */
export function bodyFingerprint(node: ts.Node) {
  const candidate =
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node)
      ? node.initializer
      : node;
  if (
    !candidate ||
    !(
      ts.isFunctionDeclaration(candidate) ||
      ts.isFunctionExpression(candidate) ||
      ts.isArrowFunction(candidate) ||
      ts.isMethodDeclaration(candidate) ||
      ts.isConstructorDeclaration(candidate) ||
      ts.isGetAccessor(candidate) ||
      ts.isSetAccessor(candidate)
    ) ||
    !candidate.body
  )
    return {};
  const body = candidate.body;
  const source = body.getSourceFile();
  const text = source.text.slice(body.getStart(source), body.end).replace(/\r\n?/g, "\n");
  return {
    bodyHash: hash(text),
    bodyLength: text.length,
    bodyStartLine: source.getLineAndCharacterOfPosition(body.getStart(source)).line + 1,
    bodyEndLine: source.getLineAndCharacterOfPosition(body.end).line + 1,
  };
}
