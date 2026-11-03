import { readFileSync } from "node:fs";
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
};

// Standard library declarations come from CodeMemory's own TypeScript package,
// never from the selected project. Without them Record, Promise and other
// built-in generics collapse to `any` and member calls through them stay unresolved.
const libDirectory = dirname(ts.getDefaultLibFilePath({}));
const libFiles = new Map<string, ts.SourceFile | null>();
const isLibFile = (path: string) =>
  dirname(path) === libDirectory && /^lib(\.[\w.]+)?\.d\.ts$/.test(basename(path));
function libSourceFile(path: string, target: ts.ScriptTarget) {
  const key = `${target}:${path}`;
  let file = libFiles.get(key);
  if (file === undefined) {
    try {
      file = ts.createSourceFile(path, readFileSync(path, "utf8"), target, true);
    } catch {
      file = null;
    }
    libFiles.set(key, file);
  }
  return file ?? undefined;
}

/** Virtual workspace mounts expose already-scanned packages to the TS resolver.
 * No method delegates a filesystem lookup to ts.sys or follows a real symlink. */
export class CompilerWorkspace {
  readonly inputs: Map<string, IndexedFile>;
  private readonly texts: Map<string, string>;
  private readonly mounts = new Map<string, string>();
  private readonly canonicalPaths = new Map<string, string>();
  private readonly redirects = new Map<string, string>();
  private readonly directories = new Set<string>();
  private readonly parsed = new Map<string, ts.ParsedCommandLine>();
  private readonly referenced = new Set<string>();
  private readonly owner = new Map<string, string>();
  // Parsed and bound SourceFiles shared between tsconfig groups whose
  // source-affecting options match, as the language service DocumentRegistry
  // does. The checker keeps its node and symbol links in private tables, so a
  // file bound by one program is safe to reuse in a later one. The registry is
  // used only for its key over parse- and bind-affecting options (jsx,
  // moduleDetection, target, alwaysStrict...); files are parsed exactly as before.
  // Each entry carries the ascending indexes of the groups predicted to use it
  // and is dropped once none of them remains, so retention never outlives the
  // last group that needs a file.
  private readonly registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);
  private readonly sourceFiles = new Map<
    string,
    { file: ts.SourceFile; uses: readonly number[]; bytes: number }
  >();
  // Upper bound on the source text retained between groups. The parsed and
  // bound trees are roughly an order of magnitude larger than their text, so
  // this caps cross-group retention at a few hundred megabytes; beyond it the
  // entries needed furthest in the future are re-parsed instead of kept.
  private retainedTextLimit = 32 * 1024 * 1024;
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
      kind: "CONFIGURATION",
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
    const cached = this.canonicalPaths.get(path);
    if (cached !== undefined) return cached;
    let normalized = resolve(path);
    for (const [virtual, actual] of this.mounts) {
      if (contains(virtual, normalized)) {
        normalized = resolve(actual, relative(virtual, normalized));
        break;
      }
    }
    this.canonicalPaths.set(path, normalized);
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
    const memberships = new Map<string, string[]>();
    for (const [name, parsed] of this.parsed)
      for (const path of parsed.fileNames) {
        const configs = memberships.get(path) ?? [];
        configs.push(name);
        memberships.set(path, configs);
      }
    for (const path of this.inputs.keys()) {
      const candidates = memberships.get(path) ?? [];
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
      noLib: false,
      libReplacement: false,
    };
  }
  *sources() {
    for (const [path, file] of this.inputs) {
      const config = this.owner.get(path) ?? "";
      yield {
        path,
        file,
        config,
        sf: ts.createSourceFile(
          path,
          file.content,
          this.options(config).target ?? ts.ScriptTarget.ESNext,
          true,
        ),
      };
    }
  }
  *programs(observe?: (durationMs: number, files: number) => void) {
    const groups = new Map<string, string[]>();
    for (const path of this.inputs.keys()) {
      const config = this.owner.get(path) ?? "";
      const group = groups.get(config) ?? [];
      group.push(path);
      groups.set(config, group);
    }
    try {
      yield* this.compile(groups, observe);
    } finally {
      // Also covers a caller that stops iterating early.
      this.sourceFiles.clear();
    }
  }
  private *compile(
    groups: Map<string, string[]>,
    observe?: (durationMs: number, files: number) => void,
  ) {
    const order = [...groups];
    const keys = order.map(([config]) =>
      this.registry.getKeyForCompilationSettings(this.options(config)),
    );
    // A single group has nothing to share, so it skips the planning pass.
    const uses = order.length > 1 ? this.plan(order, keys) : new Map<string, number[]>();
    for (const [index, [config, roots]] of order.entries()) {
      const options = this.options(config);
      const settings = keys[index];
      const host: ts.CompilerHost = {
        getSourceFile: (path, version) => {
          if (isLibFile(resolve(path)))
            return libSourceFile(
              resolve(path),
              typeof version === "object" ? version.languageVersion : version,
            );
          const actual = this.sourcePath(path),
            content = this.texts.get(actual);
          if (content === undefined) return undefined;
          // Files reached through a mount or declaration redirect get a program
          // specific fileName assigned after this call, so they are never shared.
          if (actual !== resolve(path)) return ts.createSourceFile(actual, content, version, true);
          const format = typeof version === "object" ? version.impliedNodeFormat : undefined;
          const key = `${settings}|${format ?? ""}|${actual}`;
          let entry = this.sourceFiles.get(key);
          if (!entry) {
            entry = {
              file: ts.createSourceFile(actual, content, version, true),
              uses: uses.get(`${settings}|${actual}`) ?? [],
              bytes: content.length,
            };
            this.sourceFiles.set(key, entry);
          }
          return entry.file;
        },
        getDefaultLibFileName: (o) => resolve(libDirectory, ts.getDefaultLibFileName(o)),
        getDefaultLibLocation: () => libDirectory,
        writeFile: () => {},
        getCurrentDirectory: () => this.context.canonicalRoot,
        getDirectories: (p) => [...this.directories].filter((d) => dirname(d) === resolve(p)),
        fileExists: (p) =>
          isLibFile(resolve(p))
            ? !!libSourceFile(resolve(p), options.target ?? ts.ScriptTarget.ESNext)
            : this.read(p) !== undefined,
        readFile: this.read,
        directoryExists: this.directoryExists,
        getCanonicalFileName: (p) => this.sourcePath(p),
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        getNewLine: () => "\n",
        realpath: this.sourcePath,
      };
      const resolutions = new Map<
        string,
        { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }
      >();
      host.resolveModuleNameLiterals = (literals, containingFile, _reference, _options, sf) =>
        literals.map((literal) => {
          const owner = this.owner.get(this.sourcePath(containingFile)) ?? config;
          let entry = resolutions.get(owner);
          if (!entry) {
            const options = this.options(owner);
            entry = {
              options,
              cache: ts.createModuleResolutionCache(
                this.context.canonicalRoot,
                host.getCanonicalFileName,
                options,
              ),
            };
            resolutions.set(owner, entry);
          }
          const ownOptions = entry.options;
          const resolution = ts.resolveModuleName(
            literal.text,
            containingFile,
            ownOptions,
            host,
            entry.cache,
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
      const started = observe ? performance.now() : 0;
      let program: ts.Program | undefined = ts.createProgram({ rootNames: roots, options, host });
      observe?.(performance.now() - started, roots.length);
      yield { program, roots, config };
      // The caller has finished this group before the generator resumes.
      // Release its compiler graph before constructing the next one.
      program = undefined;
      this.release(index);
      if (process.versions.bun) Bun.gc(true);
    }
  }
  /** Drops every cached file that no later group is predicted to use, then
   * evicts the files needed furthest in the future until the retained text
   * fits the limit. A wrong prediction only costs a re-parse. */
  private release(finished: number) {
    const kept: { key: string; next: number; bytes: number }[] = [];
    let bytes = 0;
    for (const [key, entry] of this.sourceFiles) {
      const next = entry.uses.find((use) => use > finished);
      if (next === undefined) this.sourceFiles.delete(key);
      else {
        kept.push({ key, next, bytes: entry.bytes });
        bytes += entry.bytes;
      }
    }
    if (bytes <= this.retainedTextLimit) return;
    kept.sort((a, b) => b.next - a.next);
    for (const entry of kept) {
      if (bytes <= this.retainedTextLimit) break;
      this.sourceFiles.delete(entry.key);
      bytes -= entry.bytes;
    }
  }
  /** Predicts which indexed files each group's program will contain: a
   * scanner-only import pre-pass (ts.preProcessFile) resolved with the same
   * owner-specific options the compiler host uses. Returns, per
   * `${settings}|${file}`, the ascending indexes of the groups that reach it. */
  private plan(order: [string, string[]][], keys: string[]) {
    const host: ts.ModuleResolutionHost = {
      fileExists: (p) => this.read(p) !== undefined,
      readFile: this.read,
      directoryExists: this.directoryExists,
      realpath: this.sourcePath,
      getCurrentDirectory: () => this.context.canonicalRoot,
      getDirectories: (p) => [...this.directories].filter((d) => dirname(d) === resolve(p)),
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    };
    const resolvers = new Map<
      string,
      { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }
    >();
    const resolver = (owner: string) => {
      let entry = resolvers.get(owner);
      if (!entry) {
        const options = this.options(owner);
        entry = {
          options,
          cache: ts.createModuleResolutionCache(
            this.context.canonicalRoot,
            this.sourcePath,
            options,
          ),
        };
        resolvers.set(owner, entry);
      }
      return entry;
    };
    // Imports resolve with the containing file's own tsconfig, so a file's
    // dependencies are shared by every group except for unowned files.
    const dependencies = new Map<string, string[]>();
    const dependenciesOf = (file: string, config: string) => {
      const owner = this.owner.get(file) ?? config;
      const memo = `${owner}\0${file}`;
      let found = dependencies.get(memo);
      if (found) return found;
      found = [];
      const text = this.texts.get(file);
      if (text !== undefined) {
        const { options, cache } = resolver(owner);
        const info = ts.preProcessFile(text, true, true);
        const mode = ts.getImpliedNodeFormatForFile(
          file,
          cache.getPackageJsonInfoCache(),
          host,
          options,
        );
        for (const imported of info.importedFiles) {
          const resolved = ts.resolveModuleName(
            imported.fileName,
            file,
            options,
            host,
            cache,
            undefined,
            mode,
          ).resolvedModule;
          if (resolved) found.push(this.sourcePath(resolved.resolvedFileName));
        }
        for (const reference of info.referencedFiles)
          found.push(this.sourcePath(resolve(dirname(file), reference.fileName)));
      }
      dependencies.set(memo, found);
      return found;
    };
    const uses = new Map<string, number[]>();
    for (const [index, [config, roots]] of order.entries()) {
      const reached = new Set(roots);
      const pending = [...roots];
      for (let file = pending.pop(); file !== undefined; file = pending.pop())
        for (const dependency of dependenciesOf(file, config))
          if (this.inputs.has(dependency) && !reached.has(dependency)) {
            reached.add(dependency);
            pending.push(dependency);
          }
      for (const file of reached) {
        const key = `${keys[index]}|${file}`;
        const list = uses.get(key);
        if (list) list.push(index);
        else uses.set(key, [index]);
      }
    }
    return uses;
  }
}
