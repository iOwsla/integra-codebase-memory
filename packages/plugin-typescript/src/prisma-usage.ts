import type { CodeSymbol } from "@codememory/core";
import { id } from "@codememory/shared";
import ts from "typescript";
import type { PrismaCatalog, PrismaGroup } from "./prisma-schema";

type Binding = {
  kind: "namespace" | "constructor" | "client" | "delegate" | "operation";
  group: PrismaGroup;
  model?: CodeSymbol;
  operation?: string;
};
const operations = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
  "findRaw",
  "aggregateRaw",
]);
const containers = new Set([
  "where",
  "select",
  "include",
  "omit",
  "data",
  "orderBy",
  "cursor",
  "having",
  "by",
  "distinct",
  "AND",
  "OR",
  "NOT",
  "some",
  "every",
  "none",
  "is",
  "isNot",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "connect",
  "connectOrCreate",
  "disconnect",
  "set",
  "delete",
  "deleteMany",
  "_count",
  "_sum",
  "_avg",
  "_min",
  "_max",
]);
/** Resolve lexical provenance with the same hermetic TS checker; names alone never imply Prisma. */
export class PrismaUsage {
  private readonly cache = new WeakMap<ts.Node, Binding | null>();
  constructor(
    private readonly catalog: PrismaCatalog,
    private readonly checker: ts.TypeChecker,
  ) {}
  private property(binding: Binding | undefined, name: string): Binding | undefined {
    if (!binding) return;
    if (binding.kind === "namespace")
      return name === "PrismaClient"
        ? { ...binding, kind: "constructor" }
        : name === "Prisma"
          ? binding
          : undefined;
    if (binding.kind === "client") {
      const model = this.catalog.modelFor(binding.group, name);
      if (model) return { ...binding, kind: "delegate", model };
    }
    if (binding.kind === "delegate" && operations.has(name))
      return { ...binding, kind: "operation", operation: name };
    return;
  }
  private imported(declaration: ts.Node): Binding | undefined {
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isImportDeclaration(current)) current = current.parent;
    if (!current || !ts.isStringLiteralLike(current.moduleSpecifier)) return;
    const group = this.catalog.clientFor(
      current.moduleSpecifier.text,
      current.getSourceFile().fileName,
    );
    if (!group) return;
    if (ts.isNamespaceImport(declaration)) return { kind: "namespace", group };
    if (ts.isImportSpecifier(declaration)) {
      const name = (declaration.propertyName ?? declaration.name).text;
      if (name === "PrismaClient") return { kind: "constructor", group };
      if (name === "Prisma") return { kind: "namespace", group };
    }
    return;
  }
  private typed(type: ts.TypeNode | undefined, seen: Set<ts.Node>): Binding | undefined {
    if (!type) return;
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName;
      const binding = ts.isQualifiedName(name)
        ? this.property(this.resolve(name.left, seen), name.right.text)
        : this.resolve(name, seen);
      if (binding?.kind === "constructor") return { ...binding, kind: "client" };
      // Delegate types are accepted only under an imported Prisma namespace.
      if (ts.isQualifiedName(name) && name.right.text.endsWith("Delegate")) {
        const namespace = this.resolve(name.left, seen);
        if (namespace?.kind === "namespace") {
          const modelName = name.right.text.slice(0, -8);
          const model = this.catalog.modelFor(
            namespace.group,
            modelName.charAt(0).toLowerCase() + modelName.slice(1),
          );
          if (model) return { ...namespace, kind: "delegate", model };
        }
      }
    }
    if (
      ts.isIndexedAccessTypeNode(type) &&
      ts.isLiteralTypeNode(type.indexType) &&
      ts.isStringLiteral(type.indexType.literal)
    )
      return this.property(this.typed(type.objectType, seen), type.indexType.literal.text);
    return;
  }
  private resolve(node: ts.Node, seen = new Set<ts.Node>()): Binding | undefined {
    if (this.cache.has(node)) return this.cache.get(node) ?? undefined;
    if (seen.has(node) || seen.size > 40) return;
    const next = new Set(seen);
    next.add(node);
    const result = this.resolveInner(node, next);
    if (result || seen.size === 0) this.cache.set(node, result ?? null);
    return result;
  }
  private resolveInner(node: ts.Node, seen: Set<ts.Node>): Binding | undefined {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      !this.checker.getSymbolAtLocation(node.expression)?.declarations?.length
    ) {
      const specifier = node.arguments[0];
      if (node.arguments.length === 1 && specifier && ts.isStringLiteralLike(specifier)) {
        const group = this.catalog.clientFor(specifier.text, node.getSourceFile().fileName);
        if (group) return { kind: "namespace", group };
      }
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return this.resolve(node.expression, seen);
    if (ts.isNewExpression(node)) {
      const binding = this.resolve(node.expression, seen);
      return binding?.kind === "constructor" ? { ...binding, kind: "client" } : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const binding = this.property(this.resolve(node.expression, seen), node.name.text);
      if (binding) return binding;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return this.property(this.resolve(node.expression, seen), node.argumentExpression.text);
    const symbol = this.checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(node) ? node.name : node,
    );
    const declarations = [...(symbol?.declarations ?? [])];
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        declarations.push(...(this.checker.getAliasedSymbol(symbol).declarations ?? []));
      } catch {
        /* Unresolved external import. */
      }
    }
    for (const declaration of declarations) {
      const imported = this.imported(declaration);
      if (imported) return imported;
      if (ts.isVariableDeclaration(declaration)) {
        if (!(declaration.parent.flags & ts.NodeFlags.Const)) continue;
        if (declaration.initializer) {
          const binding = this.resolve(declaration.initializer, seen);
          if (binding) return binding;
        }
      }
      if (
        ts.isBindingElement(declaration) &&
        ts.isObjectBindingPattern(declaration.parent) &&
        !declaration.dotDotDotToken
      ) {
        const parent = declaration.parent.parent;
        if (
          ts.isVariableDeclaration(parent) &&
          parent.initializer &&
          parent.parent.flags & ts.NodeFlags.Const
        ) {
          const name = declaration.propertyName ?? declaration.name;
          if (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
            return this.property(this.resolve(parent.initializer, seen), name.text);
        }
      }
      if (ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration)) {
        if (declaration.initializer) {
          const binding = this.resolve(declaration.initializer, seen);
          if (binding) return binding;
        }
        const typed = this.typed(declaration.type, seen);
        if (typed) return typed;
        if (
          ts.isParameter(declaration) &&
          (ts.isArrowFunction(declaration.parent) || ts.isFunctionExpression(declaration.parent))
        ) {
          const callback = declaration.parent,
            call = callback.parent;
          if (
            callback.parameters[0] === declaration &&
            ts.isCallExpression(call) &&
            call.arguments[0] === callback &&
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "$transaction"
          ) {
            const client = this.resolve(call.expression.expression, seen);
            if (client?.kind === "client") return client;
          }
        }
      }
      if (ts.isPropertyAssignment(declaration)) {
        const binding = this.resolve(declaration.initializer, seen);
        if (binding) return binding;
      }
      if (ts.isShorthandPropertyAssignment(declaration)) {
        const target = this.checker.getShorthandAssignmentValueSymbol(declaration);
        for (const d of target?.declarations ?? [])
          if (ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const) {
            const binding = this.resolve(d.initializer, seen);
            if (binding) return binding;
          }
      }
    }
    return;
  }
  call(node: ts.CallExpression, owner: CodeSymbol): boolean {
    const binding = this.resolve(node.expression);
    const sf = node.getSourceFile(),
      line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      offset = node.getStart(sf);
    if (binding?.kind === "operation" && binding.model) {
      const metadata = {
        language: "Prisma",
        operation: binding.operation,
        model: binding.model.qualifiedName,
        modelId: binding.model.id,
      };
      this.catalog.edge(owner, binding.model, "REFERENCES", line, metadata, offset);
      this.catalog.edge(owner, binding.model, "PRISMA_QUERY", line, metadata, offset);
      const args = node.arguments[0];
      if (args) this.arguments(args, binding.model, owner, metadata);
      return true;
    }
    const receiver =
      ts.isPropertyAccessExpression(node.expression) ||
      ts.isElementAccessExpression(node.expression)
        ? this.resolve(node.expression.expression)
        : undefined;
    if (
      receiver?.kind === "delegate" ||
      (receiver?.kind === "client" &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text !== "$transaction")
    ) {
      this.catalog.analysis.unresolved.push({
        id: id(owner.id, "PRISMA_QUERY", String(offset)),
        source: owner.id,
        fileId: owner.fileId,
        line,
        type: "PRISMA_QUERY",
        expression: node.getText(sf).slice(0, 300),
        reason: "Prisma receiver resolved, but operation is dynamic, raw SQL, or unsupported",
      });
      return true;
    }
    return false;
  }
  private arguments(
    node: ts.Node,
    model: CodeSymbol,
    owner: CodeSymbol,
    metadata: Record<string, unknown>,
    depth = 0,
  ) {
    if (depth > 24) return;
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        this.arguments(element, model, owner, metadata, depth + 1);
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
        continue;
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) continue;
      const key = name.text,
        child = ts.isPropertyAssignment(property) ? property.initializer : undefined;
      const field = this.catalog.fields.get(model.id)?.get(key);
      if (field) {
        const line =
          property.getSourceFile().getLineAndCharacterOfPosition(property.getStart()).line + 1;
        this.catalog.edge(
          owner,
          field,
          "REFERENCES",
          line,
          { ...metadata, field: field.name },
          property.getStart(),
        );
        const target = this.catalog.fieldTargets.get(field.id);
        if (child && target?.kind === "MODEL")
          this.arguments(child, target, owner, metadata, depth + 1);
      } else if (child && containers.has(key))
        this.arguments(child, model, owner, metadata, depth + 1);
    }
  }
}
