import { expect, it } from "vitest";
import { maskPrismaBlockComments } from "../../packages/plugin-typescript/src/prisma-comments";

it("preserves strings, escaped quotes, line comments, UTF-16 offsets and all newlines", () => {
  const prefix = `${String.raw`"escaped \" /* literal */" // /* not a block`}\r\n/// /* documentation\n`;
  const block = "/** 🧭\r\n * comment\n */";
  const suffix = " model User {\n id Int @id\n}\n";
  const result = maskPrismaBlockComments(prefix + block + suffix);
  expect(result).toBe(prefix + block.replace(/[^\r\n]/g, " ") + suffix);
  expect(result.length).toBe((prefix + block + suffix).length);
});
it("keeps unterminated comments visible instead of accepting incomplete schemas", () => {
  expect(maskPrismaBlockComments("/* ok */\n/* unclosed")).toBe("        \n/* unclosed");
});
it("keeps adjacent tokens separated and handles empty comments", () => {
  expect(maskPrismaBlockComments("model/**/User/*x*/{")).toBe("model    User     {");
});
