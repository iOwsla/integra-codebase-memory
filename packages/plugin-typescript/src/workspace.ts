import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type {
  Analysis,
  ConfigurationReferences,
  IndexedFile,
  ProjectContext,
} from "@codememory/core";
import { contains, slash } from "@codememory/shared";
import picomatch from "picomatch";
import ts from "typescript";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export const configurationReferences: ConfigurationReferences = (path, text) => {
  if (basename(path) === "package.json" || !path.endsWith(".json")) return [];
  const data = record(ts.parseConfigFileTextToJson(path, text).config);
  const extensions = Array.isArray(data.extends) ? data.extends : [data.extends];
  const refs = Array.isArray(data.references) ? data.references.map((r) => record(r).path) : [];
  return [
    ...extensions
      .filter((p): p is string => typeof p === "string" && (p.startsWith(".") || isAbsolute(p)))
      .flatMap((p) => [resolve(dirname(path), p), resolve(dirname(path), `${p}.json`)]),
    ...refs
      .filter((p): p is string => typeof p === "string")
      .flatMap((p) => [resolve(dirname(path), p), resolve(dirname(path), p, "tsconfig.json")]),
  ];
};
const defaults: ts.CompilerOptions = {
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

/** Virtual workspace mounts expose already-scanned packages to the TS resolver.
 * No method delegates a filesystem lookup to ts.sys or follows a real symlink. */
export class CompilerWorkspace {
  readonly inputs: Map<string, IndexedFile>;
  private readonly texts: Map<string, string>;
  private readonly mounts = new Map<string, string>();
  private readonly redirects = new Map<string, string>();
  private readonly directories = new Set<string>();
  private readonly parsed = new Map<string, ts.ParsedCommandLine>();
  private readonly referenced = new Set<string>();
  private readonly owner = new Map<string, string>();
  constructor(
    private readonly context: ProjectContext,
    files: IndexedFile[],
    configs: Map<string, string>,
    private readonly diagnostics: Analysis["diagnostics"],
  ) {
    this.inputs = new Map(
      files
        .filter(
          (f) =>
            f.status === "INDEXED" &&
            contains(context.canonicalRoot, resolve(context.canonicalRoot, f.path)),
        )
        .map((f) => [resolve(context.canonicalRoot, f.path), f]),
    );
    this.texts = new Map([...this.inputs].map(([path, f]) => [path, f.content]));
    for (const [path, text] of configs) {
      const actual = resolve(context.canonicalRoot, path);
      if (contains(context.canonicalRoot, actual)) this.texts.set(actual, text);
    }
    this.mountWorkspaces(configs);
    this.buildDirectories();
    this.loadProjects(configs);
    this.chooseOwners();
    this.buildRedirects();
    this.buildDirectories();
  }
  private diagnostic(file: string, message: string) {
    this.diagnostics.push({
      file: slash(relative(this.context.canonicalRoot, file)),
      message: message.slice(0, 2000),
    });
  }
  private mountWorkspaces(configs: Map<string, string>) {
    const root = this.context.canonicalRoot;
    const rootPackage = record(
      ts.parseConfigFileTextToJson("package.json", configs.get("package.json") ?? "{}").config,
    );
    const workspaceSpec = Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : record(rootPackage.workspaces).packages;
    const patterns = Array.isArray(workspaceSpec)
      ? workspaceSpec.filter((p): p is string => typeof p === "string")
      : [];
    if (!patterns.length) return;
    const positive = patterns.filter((p) => !p.startsWith("!"));
    const negative = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    const included = picomatch(positive);
    const excluded = picomatch(negative);
    const matches = (path: string) => included(path) && !excluded(path);
    const names = new Map<string, string[]>();
    for (const [path, text] of configs) {
      if (basename(path) !== "package.json" || path === "package.json") continue;
      const folder = slash(dirname(path));
      if (!matches(folder)) continue;
      const data = record(ts.parseConfigFileTextToJson(path, text).config);
      const name = data.name;
      if (
        typeof name !== "string" ||
        !/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) ||
        name.includes("..")
      )
        continue;
      names.set(name, [...(names.get(name) ?? []), resolve(root, folder)]);
    }
    for (const [name, folders] of names) {
      if (folders.length !== 1) {
        this.diagnostic(
          resolve(root, "package.json"),
          `Ambiguous workspace package ${name}; package resolution disabled for this name`,
        );
        continue;
      }
      this.mounts.set(resolve(root, "node_modules", name), folders[0] as string);
    }
  }
  private canonical = (path: string): string => {
    const normalized = resolve(path);
    for (const [virtual, actual] of this.mounts) {
      if (contains(virtual, normalized)) return resolve(actual, relative(virtual, normalized));
    }
    return normalized;
  };
  private sourcePath = (path: string): string => {
    const actual = this.canonical(path);
    return this.redirects.get(actual) ?? actual;
  };
  private read = (path: string): string | undefined => this.texts.get(this.sourcePath(path));
  private buildDirectories() {
    for (const path of [...this.texts.keys(), ...this.redirects.keys()]) {
      let p = dirname(path);
      while (contains(this.context.canonicalRoot, p)) {
        this.directories.add(p);
        if (p === this.context.canonicalRoot) break;
        p = dirname(p);
      }
    }
    for (const virtual of this.mounts.keys()) {
      let p = virtual;
      while (contains(this.context.canonicalRoot, p)) {
        this.directories.add(p);
        if (p === this.context.canonicalRoot) break;
        p = dirname(p);
      }
    }
  }
  private directoryExists = (path: string): boolean =>
    this.directories.has(resolve(path)) || this.directories.has(this.canonical(path));
  private readDirectory: ts.ParseConfigHost["readDirectory"] = (
    root,
    extensions,
    excludes,
    includes,
    depth,
  ) => {
    const normalizePattern = (pattern: string) => {
      const p = slash(resolve(root, pattern));
      return !/[?*{}[\]]/.test(pattern) && !extname(pattern) ? `${p}/**/*` : p;
    };
    const include = picomatch((includes ?? ["**/*"]).map(normalizePattern));
    const exclude = picomatch((excludes ?? []).map(normalizePattern));
    return [...this.inputs.keys()].filter(
      (p) =>
        contains(resolve(root), p) &&
        (!extensions || extensions.some((ext) => p.endsWith(ext))) &&
        (depth === undefined || relative(root, p).split(/[\\/]/).length - 1 <= depth) &&
        include(slash(p)) &&
        !exclude(slash(p)),
    );
  };
  private parse(path: string): ts.ParsedCommandLine | undefined {
    const cached = this.parsed.get(path);
    if (cached) return cached;
    if (!this.texts.has(path)) return;
    const host: ts.ParseConfigFileHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: (p) => this.texts.has(this.canonical(p)),
      readFile: this.read,
      readDirectory: this.readDirectory,
      getCurrentDirectory: () => this.context.canonicalRoot,
      onUnRecoverableConfigFileDiagnostic: (d) =>
        this.diagnostic(path, ts.flattenDiagnosticMessageText(d.messageText, " ")),
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, host);
    if (!parsed) return;
    parsed.fileNames = parsed.fileNames.filter((p) => this.inputs.has(resolve(p)));
    for (const error of parsed.errors)
      if (error.code !== 18003)
        this.diagnostic(path, ts.flattenDiagnosticMessageText(error.messageText, " "));
    this.parsed.set(path, parsed);
    return parsed;
  }
  private referencePath(path: string) {
    const direct = resolve(path);
    return this.texts.has(direct) ? direct : resolve(direct, "tsconfig.json");
  }
  private loadProjects(configs: Map<string, string>) {
    const queue = [...configs.keys()]
      .filter((p) => /^(tsconfig|jsconfig)(\..+)?\.json$/.test(basename(p)))
      .map((p) => resolve(this.context.canonicalRoot, p));
    const visited = new Set<string>();
    while (queue.length) {
      const path = queue.shift() as string;
      if (visited.has(path)) continue;
      visited.add(path);
      const parsed = this.parse(path);
      if (!parsed) continue;
      for (const reference of parsed.projectReferences ?? []) {
        const target = this.referencePath(reference.path);
        if (!contains(this.context.canonicalRoot, target) || !this.texts.has(target)) {
          this.diagnostic(
            path,
            "Referenced project config is not available within the selected source scope",
          );
          continue;
        }
        this.referenced.add(target);
        queue.push(target);
      }
    }
  }
  private chooseOwners() {
    for (const path of this.inputs.keys()) {
      const candidates = [...this.parsed]
        .filter(([, p]) => p.fileNames.includes(path))
        .map(([name]) => name);
      candidates.sort(
        (a, b) =>
          dirname(b).length - dirname(a).length ||
          Number(this.referenced.has(b)) - Number(this.referenced.has(a)) ||
          Number(basename(b) === "tsconfig.json") - Number(basename(a) === "tsconfig.json") ||
          a.localeCompare(b),
      );
      const chosen = candidates[0];
      if (chosen) this.owner.set(path, chosen);
    }
  }
  private buildRedirects() {
    const ambiguous = new Set<string>();
    for (const path of this.referenced) {
      const parsed = this.parsed.get(path);
      if (!parsed || (!parsed.options.composite && !parsed.options.declaration)) continue;
      for (const source of parsed.fileNames) {
        try {
          for (const output of ts.getOutputFileNames(
            parsed,
            source,
            !ts.sys.useCaseSensitiveFileNames,
          )) {
            if (
              !/\.d\.[cm]?ts$/.test(output) ||
              !contains(this.context.canonicalRoot, output) ||
              this.texts.has(output)
            )
              continue;
            if (ambiguous.has(resolve(output))) continue;
            const previous = this.redirects.get(resolve(output));
            if (previous && previous !== source) {
              this.redirects.delete(resolve(output));
              ambiguous.add(resolve(output));
              this.diagnostic(
                path,
                "Ambiguous referenced declaration output; source redirect omitted",
              );
            } else this.redirects.set(resolve(output), source);
          }
        } catch {
          this.diagnostic(path, "Unable to map referenced declaration output to source");
        }
      }
    }
  }
  private options(path?: string): ts.CompilerOptions {
    const parsed = path ? this.parsed.get(path) : undefined;
    return {
      ...(parsed ? parsed.options : defaults),
      allowJs: true,
      noEmit: true,
      types: [],
      noLib: true,
    };
  }
  programs() {
    const groups = new Map<string, string[]>();
    for (const path of this.inputs.keys()) {
      const config = this.owner.get(path) ?? "";
      const group = groups.get(config) ?? [];
      group.push(path);
      groups.set(config, group);
    }
    return [...groups].map(([config, roots]) => {
      const options = this.options(config);
      const host: ts.CompilerHost = {
        getSourceFile: (path, version) => {
          const actual = this.sourcePath(path),
            content = this.texts.get(actual);
          return content === undefined
            ? undefined
            : ts.createSourceFile(actual, content, version, true);
        },
        getDefaultLibFileName: () => "",
        writeFile: () => {},
        getCurrentDirectory: () => this.context.canonicalRoot,
        getDirectories: (p) => [...this.directories].filter((d) => dirname(d) === resolve(p)),
        fileExists: (p) => this.read(p) !== undefined,
        readFile: this.read,
        directoryExists: this.directoryExists,
        getCanonicalFileName: (p) => this.sourcePath(p),
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        getNewLine: () => "\n",
        realpath: this.sourcePath,
      };
      host.resolveModuleNameLiterals = (literals, containingFile, _reference, _options, sf) =>
        literals.map((literal) => {
          const ownOptions = this.options(
            this.owner.get(this.sourcePath(containingFile)) ?? config,
          );
          const resolution = ts.resolveModuleName(
            literal.text,
            containingFile,
            ownOptions,
            host,
            undefined,
            undefined,
            ts.getModeForUsageLocation(sf, literal, ownOptions),
          );
          const found = resolution.resolvedModule;
          if (found) {
            const actual = this.sourcePath(found.resolvedFileName);
            if (!this.inputs.has(actual)) return { resolvedModule: undefined };
            return {
              ...resolution,
              resolvedModule: {
                ...found,
                resolvedFileName: actual,
                isExternalLibraryImport: false,
                extension: actual.endsWith(".mts")
                  ? ts.Extension.Mts
                  : actual.endsWith(".cts")
                    ? ts.Extension.Cts
                    : actual.endsWith(".tsx")
                      ? ts.Extension.Tsx
                      : actual.endsWith(".ts")
                        ? ts.Extension.Ts
                        : found.extension,
              },
            };
          }
          return resolution;
        });
      return { program: ts.createProgram({ rootNames: roots, options, host }), roots, config };
    });
  }
}
