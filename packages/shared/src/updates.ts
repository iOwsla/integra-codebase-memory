import { version } from "../package.json";

const releaseUrl = "https://github.com/iOwsla/integra-codebase-memory/releases";
const api = "https://api.github.com/repos/iOwsla/integra-codebase-memory/releases?per_page=100";
// Only this project's numeric alpha prereleases and stable releases are eligible.
function parts(tag: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/.exec(tag);
  return match
    ? [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? Infinity : Number(match[4]),
      ]
    : undefined;
}
export function newerRelease(candidate: string, installed: string) {
  const a = parts(candidate),
    b = parts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
export type UpdateStatus = {
  currentVersion: string;
  state: "available" | "up-to-date" | "unavailable" | "disabled";
  latestVersion?: string;
  url?: string;
  instruction?: string;
  checkedAt?: string;
};
let cached: { at: number; value: UpdateStatus } | undefined;
let pending: Promise<UpdateStatus> | undefined;
export async function checkForUpdates(
  options: { force?: boolean; fetcher?: typeof fetch; current?: string } = {},
): Promise<UpdateStatus> {
  const currentVersion = options.current ?? version;
  if (process.env.CODEMEMORY_UPDATE_CHECK === "0") return { currentVersion, state: "disabled" };
  if (
    !options.fetcher &&
    !options.current &&
    !options.force &&
    cached &&
    Date.now() - cached.at < 86400000
  )
    return cached.value;
  if (!options.fetcher && !options.current && pending) return pending;
  const check = async (): Promise<UpdateStatus> => {
    try {
      const response = await (options.fetcher ?? fetch)(api, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "integra-code-memory-update-check",
        },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Unavailable");
      // Read incrementally so a malformed/oversized upstream response stays bounded.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 4 * 1024 * 1024) throw new Error("Response too large");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const entries: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(entries)) throw new Error("Invalid response");
      let latest = currentVersion;
      for (const entry of entries.slice(0, 100)) {
        if (
          entry &&
          entry.draft === false &&
          typeof entry.tag_name === "string" &&
          newerRelease(entry.tag_name, latest) &&
          (currentVersion.includes("-alpha.") || !entry.prerelease)
        )
          latest = entry.tag_name;
      }
      const available = newerRelease(latest, currentVersion);
      return {
        currentVersion,
        state: available ? "available" : "up-to-date",
        latestVersion: latest,
        checkedAt: new Date().toISOString(),
        ...(available
          ? {
              url: `${releaseUrl}/tag/${encodeURIComponent(latest)}`,
              instruction:
                "Tell the user a newer CodeMemory release is available and ask whether they want to update. Do not install or execute release content without their approval.",
            }
          : {}),
      };
    } catch {
      return { currentVersion, state: "unavailable" };
    }
  };
  if (options.fetcher || options.current) return check();
  pending = check();
  try {
    const value = await pending;
    cached = { at: Date.now(), value };
    return value;
  } finally {
    pending = undefined;
  }
}
