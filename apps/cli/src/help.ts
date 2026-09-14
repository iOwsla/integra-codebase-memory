import { type Command, Help } from "commander";

const commonCommands: Record<string, string[]> = {
  codememory: [
    "projects",
    "index",
    "status",
    "search",
    "memory",
    "history",
    "providers",
    "system",
    "update",
  ],
  "codememory history": ["configure", "status", "scan", "list", "context"],
  "codememory memory": ["configure", "status", "recall", "candidates", "review"],
};
const advancedOptions: Record<string, string[]> = {
  "codememory providers add": ["input-rate", "output-rate", "max-output-tokens", "daily-requests"],
  "codememory history configure": ["max-file-bytes", "max-storage-bytes", "retention-days"],
};
const summaries: Record<string, string> = {
  projects: "Add, list or remove project registrations",
  index: "Update the selected project's code index",
  status: "Check the selected project's index",
  search: "Search indexed source",
  memory: "Recall and review project decisions",
  history: "Collect and query documents and Git changes",
  providers: "Configure API credentials and model selection",
  system: "Set up and inspect local services",
  update: "Update the shared installation",
};
/** Filter presentation only: scripts and explicit command help retain every command. */
export function configureCliHelp(root: Command) {
  let full = false;
  const defaults = new Help();
  const visit = (cmd: Command, path: string) => {
    cmd.option("--help-all", "Show all commands and advanced options");
    cmd.on("option:help-all", () => {
      full = true;
      cmd.help();
    });
    cmd.configureHelp({
      visibleCommands: (target) => {
        const all = defaults.visibleCommands(target);
        const common = commonCommands[path];
        return full || !common ? all : all.filter((child) => common.includes(child.name()));
      },
      visibleOptions: (target) => {
        const all = defaults.visibleOptions(target);
        const advanced = advancedOptions[path] ?? [];
        return full ? all : all.filter((option) => !advanced.includes(option.name()));
      },
      subcommandDescription: (child) =>
        path === "codememory" && !full
          ? (summaries[child.name()] ?? defaults.subcommandDescription(child))
          : defaults.subcommandDescription(child),
    });
    cmd.addHelpText("after", () => {
      if (full || (!commonCommands[path] && !advancedOptions[path])) return "";
      return `\nEvery command remains available. Use '${path} --help-all' for advanced controls.`;
    });
    for (const child of cmd.commands) visit(child, `${path} ${child.name()}`);
  };
  visit(root, root.name());
}
