import { fileURLToPath } from "node:url";

// Both source scripts/ and the bundled CLI's dist/ are immediate children.
export const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
