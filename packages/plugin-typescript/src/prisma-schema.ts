import { dirname, resolve } from "node:path";
import type {
  Analysis,
  CodeSymbol,
  IndexedFile,
  ProjectContext,
  SymbolKind,
} from "@codememory/core";
import { contains, hash, id, slash } from "@codememory/shared";
import type {
  FieldDeclaration,
  PrismaSchema,
  SchemaArgument,
  SchemaExpression,
  SourceRange,
} from "@loancrate/prisma-schema-parser";
import { parsePrismaSchema } from "@loancrate/prisma-schema-parser";

function value(expression: SchemaExpression): unknown {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "path") return expression.value.join(".");
  if (expression.kind === "array") return expression.items.map(value);
  return { function: expression.path.value.join("."), arguments: args(expression.args) };
}
function args(arguments_: SchemaArgument[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let position = 0;
  for (const argument of arguments_) {
    if (argument.kind === "namedArgument") result[argument.name.value] = value(argument.expression);
    else result[String(position++)] = value(argument);
  }
  return result;
}
export interface PrismaGroup {
  root: string;
  packageRoot: string;
  defaultClient: boolean;
  outputs: string[];
  models: Map<string, CodeSymbol[]>;
}
export class PrismaCatalog {
  readonly groups: PrismaGroup[] = [];
  readonly fields = new Map<string, Map<string, CodeSymbol>>();
  readonly fieldTargets = new Map<string, CodeSymbol>();
  private readonly delegates = new WeakMap<PrismaGroup, Map<string, CodeSymbol[]>>();
  private readonly schemaFiles: { file: IndexedFile; ast: PrismaSchema }[] = [];
  constructor(
    private readonly context: ProjectContext,
    files: IndexedFile[],
    private readonly configs: Map<string, string>,
    readonly analysis: Analysis,
  ) {
    for (const file of files.filter((f) => f.path.endsWith(".prisma") && f.status === "INDEXED")) {
      try {
        this.schemaFiles.push({ file, ast: parsePrismaSchema(file.content) });
      } catch (error) {
        const e = error as {
          message?: string;
          location?: SourceRange;
          cause?: { location?: SourceRange };
        };
        const location = e.location ?? e.cause?.location;
        analysis.diagnostics.push({
          file: file.path,
          kind: "SYNTAX_ERROR",
          message: `Prisma schema: ${e.message ?? "Parse failed"}`.slice(0, 2000),
          line: location?.start.line,
          column: location?.start.column,
        });
      }
    }
    const roots = this.schemaFiles
      .filter(({ ast }) => ast.declarations.some((d) => d.kind === "generator"))
      .map(({ file }) => resolve(context.canonicalRoot, dirname(file.path)));
    const members: {
      group: PrismaGroup;
      model: CodeSymbol;
      field: CodeSymbol;
      declaration: FieldDeclaration;
    }[] = [];
    for (const { file, ast } of this.schemaFiles) {
      const path = resolve(context.canonicalRoot, file.path);
      let groupRoot =
        roots
          .filter((r) => contains(r, path) && this.packageFor(r) === this.packageFor(path))
          .sort((a, b) => b.length - a.length)[0] ?? dirname(path);
      if (roots.filter((r) => r === groupRoot).length > 1) groupRoot = path;
      let group = this.groups.find((g) => g.root === groupRoot);
      if (!group) {
        group = {
          root: groupRoot,
          packageRoot: this.packageFor(path),
          defaultClient: false,
          outputs: [],
          models: new Map(),
        };
        this.groups.push(group);
      }
      const root = this.symbol(
        file,
        "FILE",
        file.path,
        file.path,
        {
          start: { offset: 0, line: 1, column: 1 },
          end: {
            offset: file.content.length,
            line: file.content.split("\n").length,
            column: (file.content.split("\n").at(-1)?.length ?? 0) + 1,
          },
        },
        { language: "Prisma" },
      );
      for (const declaration of ast.declarations) {
        if (declaration.kind === "generator") {
          const config = Object.fromEntries(
            declaration.members
              .filter((m) => m.kind === "config")
              .map((m) => [m.name.value, value(m.value)]),
          );
          if (config.provider === "prisma-client-js" || config.provider === "prisma-client") {
            if (typeof config.output === "string")
              group.outputs.push(resolve(dirname(path), config.output));
            else if (config.provider === "prisma-client-js") group.defaultClient = true;
          }
        }
        if (
          !["model", "view", "type", "enum"].includes(declaration.kind) ||
          !("members" in declaration)
        )
          continue;
        const model = this.symbol(
          file,
          declaration.kind === "enum"
            ? "ENUM"
            : declaration.kind === "type"
              ? "TYPE_ALIAS"
              : "MODEL",
          declaration.name.value,
          declaration.name.value,
          declaration.location,
          {
            language: "Prisma",
            schemaGroup: slash(groupRoot.slice(context.canonicalRoot.length + 1)),
            declarationKind: declaration.kind,
            attributes: declaration.members
              .filter((m) => m.kind === "blockAttribute")
              .map((m) => ({ name: m.path.value.join("."), arguments: args(m.args) })),
          },
        );
        this.edge(root, model, "DECLARES", model.startLine);
        const candidates = group.models.get(model.name) ?? [];
        candidates.push(model);
        group.models.set(model.name, candidates);
        const fields = new Map<string, CodeSymbol>();
        this.fields.set(model.id, fields);
        for (const member of declaration.members) {
          if (member.kind !== "field" && member.kind !== "enumValue") continue;
          const field = this.symbol(
            file,
            "FIELD",
            member.name.value,
            `${model.name}.${member.name.value}`,
            member.location,
            {
              language: "Prisma",
              parentId: model.id,
              attributes:
                member.attributes?.map((a) => ({
                  name: a.path.value.join("."),
                  arguments: args(a.args),
                })) ?? [],
            },
          );
          fields.set(field.name, field);
          this.edge(model, field, "DECLARES", field.startLine);
          if (member.kind === "field") {
            const base =
              member.type.kind === "list" ||
              member.type.kind === "optional" ||
              member.type.kind === "required"
                ? member.type.type
                : member.type;
            field.metadata.type = base.kind === "typeId" ? base.name.value : "Unsupported";
            field.metadata.optional = member.type.kind === "optional";
            field.metadata.list = member.type.kind === "list";
            members.push({ group, model, field, declaration: member });
          }
        }
      }
    }
    const scalar = new Set([
      "String",
      "Boolean",
      "Int",
      "BigInt",
      "Float",
      "Decimal",
      "DateTime",
      "Json",
      "Bytes",
      "Unsupported",
    ]);
    for (const { group, model, field, declaration } of members) {
      const name = String(field.metadata.type);
      if (scalar.has(name)) continue;
      const targets = group.models.get(name) ?? [];
      if (targets.length !== 1) {
        this.unresolved(field, "PRISMA_TYPE", `Schema type ${name} is missing or ambiguous`);
        continue;
      }
      const target = targets[0];
      if (!target) continue;
      this.fieldTargets.set(field.id, target);
      this.edge(
        field,
        target,
        target.kind === "MODEL" ? "RELATION_MODEL" : "TYPE_OF",
        field.startLine,
      );
      if (target.kind === "MODEL") {
        this.edge(model, target, "RELATES_TO", field.startLine);
        const relation = declaration.attributes?.find((a) => a.path.value.join(".") === "relation");
        const relationArgs = args(relation?.args);
        field.metadata.relation = relationArgs;
        const local = relationArgs.fields,
          remote = relationArgs.references;
        if (Array.isArray(local) && Array.isArray(remote)) {
          if (local.length !== remote.length)
            this.unresolved(field, "PRISMA_RELATION", "Relation field/reference counts differ");
          else
            local.forEach((name, index) => {
              const from = this.fields.get(model.id)?.get(String(name)),
                to = this.fields.get(target.id)?.get(String(remote[index]));
              if (from && to) this.edge(from, to, "FOREIGN_KEY", field.startLine);
              else
                this.unresolved(
                  field,
                  "PRISMA_RELATION",
                  "Relation scalar field or referenced field is missing",
                );
            });
        }
      }
    }
    for (const group of this.groups)
      for (const candidates of group.models.values())
        if (candidates.length > 1)
          for (const model of candidates)
            this.unresolved(model, "PRISMA_SCHEMA", "Duplicate declaration in schema group");
  }
  packageFor(path: string) {
    return (
      [...this.configs.keys()]
        .filter((p) => p === "package.json" || p.endsWith("/package.json"))
        .map((p) => resolve(this.context.canonicalRoot, dirname(p)))
        .filter((p) => contains(p, path))
        .sort((a, b) => b.length - a.length)[0] ?? this.context.canonicalRoot
    );
  }
  clientFor(module: string, from: string): PrismaGroup | undefined {
    const candidates =
      module === "@prisma/client"
        ? this.groups.filter((g) => g.defaultClient && g.packageRoot === this.packageFor(from))
        : module.startsWith(".")
          ? this.groups.filter((g) =>
              g.outputs.some((output) => {
                const path = resolve(dirname(from), module).replace(/\.[cm]?[jt]s$/, "");
                return [output, resolve(output, "client"), resolve(output, "index")].includes(path);
              }),
            )
          : [];
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  modelFor(group: PrismaGroup, delegate: string) {
    let lookup = this.delegates.get(group);
    if (!lookup) {
      lookup = new Map();
      for (const candidates of group.models.values())
        for (const model of candidates) {
          if (
            model.kind !== "MODEL" ||
            (model.metadata.attributes as { name: string }[]).some((a) => a.name === "ignore")
          )
            continue;
          const key = model.name.charAt(0).toLowerCase() + model.name.slice(1);
          const entries = lookup.get(key) ?? [];
          entries.push(model);
          lookup.set(key, entries);
        }
      this.delegates.set(group, lookup);
    }
    const matches = lookup.get(delegate) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }

  edge(
    source: CodeSymbol,
    target: CodeSymbol,
    type: string,
    line: number,
    metadata?: Record<string, unknown>,
    offset = line,
  ) {
    this.analysis.edges.push({
      id: id(source.id, target.id, type, String(offset)),
      source: source.id,
      target: target.id,
      type,
      fileId: source.fileId,
      line,
      resolution: "AST_CONFIRMED",
      confidence: 1,
      ...(metadata ? { metadata } : {}),
    });
  }
  unresolved(source: CodeSymbol, type: string, reason: string) {
    this.analysis.unresolved.push({
      id: id(source.id, type, reason),
      source: source.id,
      fileId: source.fileId,
      line: source.startLine,
      type,
      expression: source.qualifiedName,
      reason,
    });
    this.analysis.diagnostics.push({
      file: source.file,
      kind: "CONFIGURATION",
      line: source.startLine,
      column: source.startColumn,
      message: reason,
    });
  }
  private symbol(
    file: IndexedFile,
    kind: SymbolKind,
    name: string,
    qualifiedName: string,
    location: SourceRange | undefined,
    metadata: Record<string, unknown>,
  ): CodeSymbol {
    const start = location?.start ?? { line: 1, column: 1, offset: 0 },
      end = location?.end ?? start;
    const symbol: CodeSymbol = {
      id: id(file.id, "prisma", kind, qualifiedName, String(start.offset)),
      fileId: file.id,
      file: file.path,
      kind,
      name,
      qualifiedName,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      signature:
        file.content.slice(start.offset, end.offset).split("\n")[0]?.slice(0, 1000) ?? name,
      contentHash: hash(file.content.slice(start.offset, end.offset)),
      exported: true,
      async: false,
      static: false,
      visibility: "public",
      metadata,
    };
    this.analysis.symbols.push(symbol);
    return symbol;
  }
}
