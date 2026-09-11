import { dirname, relative, resolve } from "node:path";
import type {
  Analysis,
  CodeSymbol,
  IndexedFile,
  LanguagePlugin,
  ProjectContext,
  SymbolKind,
} from "@codememory/core";
import { hash, id, slash } from "@codememory/shared";
import ts from "typescript";

/** Compiler input is an in-memory allowlist produced by the bounded scanner. */
export class TypeScriptPlugin implements LanguagePlugin {
  readonly id = "typescript";
  readonly version = `2:${ts.version}`;
  readonly extensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
  constructor(private readonly observe: (path: string) => void = () => {}) {}
  async analyze(
    context: ProjectContext,
    files: IndexedFile[],
    configs: Map<string, string>,
  ): Promise<Analysis> {
    const result: Analysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };
    const inputs = new Map(
      files
        .filter((f) => f.status === "INDEXED")
        .map((f) => [resolve(context.canonicalRoot, f.path), f]),
    );
    const texts = new Map([...inputs].map(([path, f]) => [path, f.content]));
    for (const [path, text] of configs) texts.set(resolve(context.canonicalRoot, path), text);
    const directories = new Set<string>();
    for (const path of texts.keys()) {
      let p = dirname(path);
      while (p !== dirname(p)) {
        directories.add(p);
        p = dirname(p);
      }
    }
    const read = (path: string) => texts.get(resolve(path));
    const optionsDefault: ts.CompilerOptions = {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
      types: [],
      noLib: true,
    };
    const configPaths = [...configs.keys()]
      .filter((p) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(p))
      .map((p) => resolve(context.canonicalRoot, p));
    const groups = new Map<string, string[]>();
    for (const path of inputs.keys()) {
      const config =
        configPaths
          .filter((c) => path.startsWith(`${dirname(c)}/`))
          .sort((a, b) => b.length - a.length)[0] ?? "";
      groups.set(config, [...(groups.get(config) ?? []), path]);
    }
    const symbolIds = new Map<string, CodeSymbol>();
    const declarations = new Map<string, CodeSymbol>();
    const fileSymbols = new Map<string, CodeSymbol>();
    const key = (n: ts.Node) => `${resolve(n.getSourceFile().fileName)}:${n.getStart()}`;
    const owners = new Map<ts.Node, CodeSymbol>();
    const programs: { program: ts.Program; roots: string[] }[] = [];
    for (const [config, roots] of groups) {
      let options = { ...optionsDefault };
      if (config) {
        try {
          const parsed = ts.parseConfigFileTextToJson(config, read(config) ?? "{}");
          if (parsed.error)
            throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, " "));
          const loaded = ts.parseJsonConfigFileContent(
            parsed.config,
            {
              useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
              fileExists: (p) => texts.has(resolve(p)),
              readFile: read,
              readDirectory: (root) =>
                [...texts.keys()].filter((p) => p.startsWith(`${resolve(root)}/`)),
            },
            dirname(config),
            {},
            config,
          );
          options = {
            ...loaded.options,
            ...{ allowJs: true, noEmit: true, types: [], noLib: true },
          };
          for (const err of loaded.errors)
            if (err.code !== 18003)
              result.diagnostics.push({
                file: slash(relative(context.canonicalRoot, config)),
                message: ts.flattenDiagnosticMessageText(err.messageText, " ").slice(0, 2000),
              });
        } catch (error) {
          result.diagnostics.push({
            file: slash(relative(context.canonicalRoot, config)),
            message: String(error).slice(0, 2000),
          });
        }
      }
      const host: ts.CompilerHost = {
        getSourceFile: (path, version) => {
          const content = read(path);
          return content === undefined
            ? undefined
            : ts.createSourceFile(path, content, version, true);
        },
        getDefaultLibFileName: () => "",
        writeFile: () => {},
        getCurrentDirectory: () => context.canonicalRoot,
        getDirectories: (p) => [...directories].filter((d) => dirname(d) === resolve(p)),
        fileExists: (p) => texts.has(resolve(p)),
        readFile: read,
        directoryExists: (p) => directories.has(resolve(p)),
        getCanonicalFileName: (p) => resolve(p),
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        getNewLine: () => "\n",
        realpath: (p) => resolve(p),
      };
      programs.push({ program: ts.createProgram({ rootNames: roots, options, host }), roots });
    }
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
        name,
      ].join(".");
      const qualifiedName =
        parent && parent.kind !== "FILE" ? `${parent.qualifiedName}.${localName}` : localName;
      const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
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
        exported: !!mods?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
        ),
        async: !!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        static: !!mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword),
        visibility: mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
          ? "private"
          : mods?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)
            ? "protected"
            : "public",
        contentHash: hash(node.getText()),
        metadata: { parentId: parent?.id },
      };
      const existing = symbolIds.get(sym.id);
      if (existing) {
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
        return { kind: "FUNCTION", name: name ?? `<anonymous@${node.getStart()}>` };
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
        return {
          kind:
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
              ? "FUNCTION"
              : node.parent.flags & ts.NodeFlags.Const
                ? "CONSTANT"
                : "VARIABLE",
          name,
        };
      }
      if (ts.isModuleDeclaration(node)) return { kind: "MODULE", name: node.name.getText() };
      return;
    };
    for (const { program, roots } of programs)
      for (const path of roots) {
        const sf = program.getSourceFile(path),
          file = inputs.get(path);
        if (!sf || !file) continue;
        this.observe(path);
        const root = addSymbol(sf, file, "FILE", file.path);
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
            owner.exported =
              ts.isVariableStatement(node.parent.parent) &&
              !!ts
                .getModifiers(node.parent.parent)
                ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
            if (owner.exported) addEdge(root, owner, "EXPORTS", owner.startLine, "AST_CONFIRMED");
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
      const targetOf = (node: ts.Node): CodeSymbol | undefined => {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          try {
            symbol = checker.getAliasedSymbol(symbol);
          } catch {
            return;
          }
        }
        for (const d of symbol?.declarations ?? []) {
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
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
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
            const isDeclaration = (node.parent as ts.NamedDeclaration).name === node;
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
