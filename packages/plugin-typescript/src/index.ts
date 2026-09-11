import { resolve } from "node:path";
import type {
  Analysis,
  CodeSymbol,
  IndexedFile,
  LanguagePlugin,
  ProjectContext,
  SymbolKind,
} from "@codememory/core";
import { hash, id } from "@codememory/shared";
import ts from "typescript";
import { CompilerWorkspace, configurationReferences } from "./workspace";

/** Compiler input is an in-memory allowlist produced by the bounded scanner. */
export class TypeScriptPlugin implements LanguagePlugin {
  readonly id = "typescript";
  readonly version = `3:${ts.version}`;
  readonly configurationReferences = configurationReferences;
  readonly extensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
  constructor(private readonly observe: (path: string) => void = () => {}) {}
  async analyze(
    context: ProjectContext,
    files: IndexedFile[],
    configs: Map<string, string>,
  ): Promise<Analysis> {
    const result: Analysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };
    const workspace = new CompilerWorkspace(context, files, configs, result.diagnostics);
    const inputs = workspace.inputs;
    const symbolIds = new Map<string, CodeSymbol>();
    const declarations = new Map<string, CodeSymbol>();
    const fileSymbols = new Map<string, CodeSymbol>();
    const key = (n: ts.Node) => `${resolve(n.getSourceFile().fileName)}:${n.getStart()}`;
    const owners = new Map<ts.Node, CodeSymbol>();
    const programs = workspace.programs();
    const addSymbol = (
      node: ts.Node,
      file: IndexedFile,
      kind: SymbolKind,
      name: string,
      parent?: CodeSymbol,
    ): CodeSymbol => {
      const sf = node.getSourceFile();
      const start = sf.getLineAndCharacterOfPosition(node.getStart());
      const end = sf.getLineAndCharacterOfPosition(node.getEnd());
      const blocks: string[] = [];
      let ancestor = node.parent;
      while (ancestor && !owners.has(ancestor)) {
        if (ts.isBlock(ancestor) && !ts.isFunctionLike(ancestor.parent))
          blocks.unshift(`<block@${ancestor.getStart()}>`);
        ancestor = ancestor.parent;
      }
      const localName = [
        ...blocks,
        ...(kind === "IMPORT" ? ["import"] : kind === "EXPORT" ? ["export"] : []),
        ts.isGetAccessor(node) ? `${name}[get]` : ts.isSetAccessor(node) ? `${name}[set]` : name,
      ].join(".");
      const qualifiedName =
        parent && parent.kind !== "FILE" ? `${parent.qualifiedName}.${localName}` : localName;
      let modifierOwner = node;
      if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
        while (
          modifierOwner.parent &&
          !ts.isVariableStatement(modifierOwner) &&
          !ts.isFunctionLike(modifierOwner.parent)
        )
          modifierOwner = modifierOwner.parent;
      }
      const mods = ts.canHaveModifiers(modifierOwner) ? ts.getModifiers(modifierOwner) : undefined;
      const sym: CodeSymbol = {
        id: id(context.projectScopeId, file.path, kind, qualifiedName),
        fileId: file.id,
        file: file.path,
        kind,
        name,
        qualifiedName,
        startLine: start.line + 1,
        startColumn: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        signature: node.getText().split(/\r?\n/)[0]?.slice(0, 500) ?? "",
        exported:
          (!!node.parent && ts.isExportAssignment(node.parent)) ||
          !!mods?.some(
            (m) =>
              m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
          ),
        async: !!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        static: !!mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword),
        visibility: mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
          ? "private"
          : mods?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)
            ? "protected"
            : "public",
        contentHash: hash(node.getText()),
        metadata: {
          parentId: parent?.id,
          tsconfig: parent?.metadata.tsconfig,
          ...(ts.isGetAccessor(node)
            ? { accessor: "get" }
            : ts.isSetAccessor(node)
              ? { accessor: "set" }
              : {}),
        },
      };
      const existing = symbolIds.get(sym.id);
      if (existing) {
        existing.endLine = Math.max(existing.endLine, sym.endLine);
        existing.endColumn = sym.endColumn;
        existing.contentHash = hash(existing.contentHash + sym.contentHash);
        declarations.set(key(node), existing);
        owners.set(node, existing);
        return existing;
      }
      result.symbols.push(sym);
      symbolIds.set(sym.id, sym);
      declarations.set(key(node), sym);
      owners.set(node, sym);
      if (parent) addEdge(parent, sym, "DECLARES", sym.startLine, "AST_CONFIRMED");
      if (sym.exported && parent) addEdge(parent, sym, "EXPORTS", sym.startLine, "AST_CONFIRMED");
      return sym;
    };
    const addEdge = (
      source: CodeSymbol,
      target: CodeSymbol,
      type: string,
      line: number,
      resolution: "AST_CONFIRMED" | "SEMANTIC_CONFIRMED",
    ) => {
      result.edges.push({
        id: id(source.id, target.id, type, String(line)),
        source: source.id,
        target: target.id,
        type,
        confidence: 1,
        resolution,
        fileId: source.fileId,
        line,
      });
    };
    const classify = (node: ts.Node): { kind: SymbolKind; name: string } | undefined => {
      const named = node as ts.NamedDeclaration;
      const name = named.name?.getText();
      if (
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        (ts.isImportClause(node) && node.name)
      )
        return { kind: "IMPORT", name: name ?? "<import>" };
      if (ts.isExportSpecifier(node)) return { kind: "EXPORT", name: name ?? "<export>" };
      if (
        ts.isFunctionDeclaration(node) ||
        (ts.isFunctionExpression(node) && !ts.isVariableDeclaration(node.parent))
      )
        return {
          kind: "FUNCTION",
          name:
            name ??
            (ts
              .getModifiers(node as ts.FunctionDeclaration)
              ?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
              ? "default"
              : `<anonymous@${node.getStart()}>`),
        };
      if (
        ts.isArrowFunction(node) &&
        !ts.isVariableDeclaration(node.parent) &&
        !ts.isPropertyDeclaration(node.parent)
      )
        return { kind: "FUNCTION", name: `<arrow@${node.getStart()}>` };
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
        return { kind: "CLASS", name: name ?? "default" };
      if (ts.isInterfaceDeclaration(node)) return { kind: "INTERFACE", name: node.name.text };
      if (ts.isTypeAliasDeclaration(node)) return { kind: "TYPE_ALIAS", name: node.name.text };
      if (ts.isEnumDeclaration(node)) return { kind: "ENUM", name: node.name.text };
      if (ts.isConstructorDeclaration(node)) return { kind: "CONSTRUCTOR", name: "constructor" };
      if (
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node)
      )
        return { kind: "METHOD", name: name ?? "<computed>" };
      if (
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyAssignment(node)
      )
        return { kind: "PROPERTY", name: name ?? "<computed>" };
      if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
        if (!name || (!ts.isIdentifier(named.name as ts.Node) && ts.isVariableDeclaration(node)))
          return;
        let declarationList: ts.Node = node.parent;
        while (
          declarationList.parent &&
          !ts.isVariableDeclarationList(declarationList) &&
          !ts.isFunctionLike(declarationList)
        )
          declarationList = declarationList.parent;
        return {
          kind:
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
              ? "FUNCTION"
              : declarationList.flags & ts.NodeFlags.Const
                ? "CONSTANT"
                : "VARIABLE",
          name,
        };
      }
      if (ts.isModuleDeclaration(node)) return { kind: "MODULE", name: node.name.getText() };
      return;
    };
    for (const { program, roots, config } of programs)
      for (const path of roots) {
        const sf = program.getSourceFile(path),
          file = inputs.get(path);
        if (!sf || !file) continue;
        this.observe(path);
        const root = addSymbol(sf, file, "FILE", file.path);
        root.metadata.tsconfig = config
          ? config.slice(context.canonicalRoot.length + 1).replaceAll("\\", "/")
          : null;
        fileSymbols.set(path, root);
        const visit = (node: ts.Node, parent: CodeSymbol) => {
          const classification = classify(node);
          const owner = classification
            ? addSymbol(node, file, classification.kind, classification.name, parent)
            : parent;
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ) {
            owners.set(node.initializer, owner);
            declarations.set(key(node.initializer), owner);
            owner.async = !!ts
              .getModifiers(node.initializer)
              ?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
          }
          ts.forEachChild(node, (n) => visit(n, owner));
        };
        ts.forEachChild(sf, (n) => visit(n, root));
        for (const d of program.getSyntacticDiagnostics(sf))
          result.diagnostics.push({
            file: file.path,
            message: ts.flattenDiagnosticMessageText(d.messageText, " ").slice(0, 2000),
          });
      }
    for (const { program, roots } of programs) {
      const checker = program.getTypeChecker();
      const unshadowed = (node: ts.Identifier) =>
        !checker.getSymbolAtLocation(node)?.declarations?.some((d) => {
          const name = (d as ts.NamedDeclaration).name;
          return !!name && ts.isIdentifier(name) && name.text === node.text;
        });
      const commonJsExport = (node: ts.Node): boolean => {
        const parts: string[] = [];
        let base = node;
        while (ts.isPropertyAccessExpression(base)) {
          parts.unshift(base.name.text);
          base = base.expression;
        }
        return (
          ts.isIdentifier(base) &&
          unshadowed(base) &&
          ((base.text === "module" && parts[0] === "exports" && parts.length <= 2) ||
            (base.text === "exports" && parts.length === 1))
        );
      };
      const targetOf = (node: ts.Node): CodeSymbol | undefined => {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          try {
            symbol = checker.getAliasedSymbol(symbol);
          } catch {
            return;
          }
        }
        let candidates = symbol?.declarations ?? [];
        if (
          node.parent &&
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) {
          const access = node.parent;
          const write =
            ts.isBinaryExpression(access.parent) &&
            access.parent.left === access &&
            access.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            access.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
          const accessors = candidates.filter(write ? ts.isSetAccessor : ts.isGetAccessor);
          if (accessors.length) candidates = accessors;
        }
        for (const d of candidates) {
          const found = declarations.get(key(d));
          if (found) return found;
        }
        return;
      };
      for (const path of roots) {
        const sf = program.getSourceFile(path),
          root = fileSymbols.get(path);
        if (!sf || !root) continue;
        const unresolved = (node: ts.Node, owner: CodeSymbol, type: string) => {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          result.unresolved.push({
            id: id(owner.id, type, String(node.getStart()), String(node.getEnd())),
            source: owner.id,
            fileId: owner.fileId,
            line,
            expression: node.getText().slice(0, 300),
            reason: "Dynamic, external, excluded, or not statically resolved within project scope",
            type,
          });
        };
        const visit = (node: ts.Node, parent: CodeSymbol) => {
          const owner = owners.get(node) ?? declarations.get(key(node)) ?? parent;
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                node.expression.text === "require" &&
                unshadowed(node.expression)))
          ) {
            const argument = node.arguments[0];
            const symbol =
              argument && ts.isStringLiteralLike(argument)
                ? checker.getSymbolAtLocation(argument)
                : undefined;
            const sourceFile = symbol?.declarations?.find(ts.isSourceFile);
            const target = sourceFile ? fileSymbols.get(resolve(sourceFile.fileName)) : undefined;
            if (target) addEdge(owner, target, "IMPORTS", line, "SEMANTIC_CONFIRMED");
            else unresolved(node, owner, "IMPORTS");
          } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            let target: CodeSymbol | undefined;
            const signature = checker.getResolvedSignature(node);
            if (signature?.declaration) target = declarations.get(key(signature.declaration));
            target ??= targetOf(
              ts.isPropertyAccessExpression(node.expression)
                ? node.expression.name
                : node.expression,
            );
            if (target) addEdge(owner, target, "CALLS", line, "SEMANTIC_CONFIRMED");
            else unresolved(node, owner, "CALLS");
          }
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const spec = node.moduleSpecifier;
            if (spec) {
              const symbol = checker.getSymbolAtLocation(spec);
              const sourceFile = symbol?.declarations?.find(ts.isSourceFile);
              const target = sourceFile ? fileSymbols.get(resolve(sourceFile.fileName)) : undefined;
              if (target)
                addEdge(
                  root,
                  target,
                  ts.isImportDeclaration(node) ? "IMPORTS" : "RE_EXPORTS",
                  line,
                  "SEMANTIC_CONFIRMED",
                );
              else unresolved(node, root, "IMPORTS");
            }
          }
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            commonJsExport(node.left)
          ) {
            const target = declarations.get(key(node.right)) ?? targetOf(node.right);
            if (target) {
              target.exported = true;
              addEdge(root, target, "EXPORTS", line, "AST_CONFIRMED");
            } else unresolved(node, root, "EXPORTS");
          }
          if (ts.isExportSpecifier(node)) {
            const target = targetOf(node.name);
            if (target) addEdge(root, target, "EXPORTS", line, "SEMANTIC_CONFIRMED");
          }
          if (ts.isExportAssignment(node)) {
            const target = targetOf(node.expression);
            if (target) addEdge(root, target, "EXPORTS", line, "SEMANTIC_CONFIRMED");
          }
          if (ts.isHeritageClause(node))
            for (const type of node.types) {
              const target = targetOf(type.expression);
              if (target)
                addEdge(
                  owner,
                  target,
                  node.token === ts.SyntaxKind.ExtendsKeyword ? "EXTENDS" : "IMPLEMENTS",
                  line,
                  "SEMANTIC_CONFIRMED",
                );
              else unresolved(type, owner, "HERITAGE");
            }
          if (ts.isIdentifier(node)) {
            const isDeclaration =
              !ts.isPropertyAccessExpression(node.parent) &&
              (node.parent as ts.NamedDeclaration).name === node;
            const target = targetOf(node);
            if (target && !isDeclaration && target.id !== owner.id)
              addEdge(owner, target, "REFERENCES", line, "SEMANTIC_CONFIRMED");
          }
          ts.forEachChild(node, (n) => visit(n, owner));
        };
        ts.forEachChild(sf, (n) => visit(n, root));
      }
    }
    result.edges = [...new Map(result.edges.map((e) => [e.id, e])).values()];
    return result;
  }
}
