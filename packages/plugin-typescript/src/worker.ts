import type { IndexedFile, ProjectContext } from "@codememory/core";
import { TypeScriptPlugin } from "./index";

const input = JSON.parse(await Bun.stdin.text()) as {
  context: ProjectContext;
  files: IndexedFile[];
  configs: [string, string][];
};
process.stdout.write(
  JSON.stringify(
    await new TypeScriptPlugin().analyze(input.context, input.files, new Map(input.configs)),
  ),
);
