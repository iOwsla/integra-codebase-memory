import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

const schema = `generator client {
 provider = "prisma-client-js"
}
model User {
 id Int @id
 email String @unique @map("email_address")
 posts Post[] @relation("AuthorPosts")
 @@map("people")
}
model Post {
 id Int @id
 authorId Int
 author User @relation("AuthorPosts", fields: [authorId], references: [id], onDelete: Cascade)
 title String
}
`;
async function analyze(files: Record<string, string>, isolated = false) {
  const f = await fixture({ "package.json": "{}", ...files });
  try {
    const c = await createProjectContext(f.root),
      scan = await new RepositoryScanner().scan(c);
    if (isolated) {
      const output = await promisify(execFile)("bun", [
        "-e",
        `
        import {RepositoryScanner} from '@codememory/indexer';
        import {ProcessTypeScriptPlugin} from '@codememory/plugin-typescript/process';
        import {createProjectContext} from '@codememory/shared';
        const c=await createProjectContext(${JSON.stringify(f.root)});
        const scan=await new RepositoryScanner().scan(c);
        console.log(JSON.stringify(await new ProcessTypeScriptPlugin().analyze(c,scan.files,scan.configs)));
      `,
      ]);
      return JSON.parse(output.stdout) as Awaited<ReturnType<TypeScriptPlugin["analyze"]>>;
    }
    return await new TypeScriptPlugin().analyze(c, scan.files, scan.configs);
  } finally {
    await f.dispose();
  }
}
it("indexes located Prisma models, mapped fields and relation/FK directions", async () => {
  const a = await analyze({ "prisma/schema.prisma": schema });
  expect(a.diagnostics).toEqual([]);
  const user = a.symbols.find((s) => s.kind === "MODEL" && s.name === "User")!;
  const post = a.symbols.find((s) => s.kind === "MODEL" && s.name === "Post")!;
  const author = a.symbols.find((s) => s.qualifiedName === "Post.author")!;
  expect(user.startLine).toBe(4);
  expect(user.endLine).toBe(9);
  expect(user.metadata.attributes).toContainEqual({ name: "map", arguments: { "0": "people" } });
  expect(author.metadata.relation).toEqual({
    "0": "AuthorPosts",
    fields: ["authorId"],
    references: ["id"],
    onDelete: "Cascade",
  });
  expect(a.edges).toContainEqual(
    expect.objectContaining({ source: post.id, target: user.id, type: "RELATES_TO" }),
  );
  expect(a.edges).toContainEqual(
    expect.objectContaining({
      source: a.symbols.find((s) => s.qualifiedName === "Post.authorId")!.id,
      target: a.symbols.find((s) => s.qualifiedName === "User.id")!.id,
      type: "FOREIGN_KEY",
    }),
  );
});
it("follows renamed clients, imported delegates, destructuring, extracted methods and transaction aliases", async () => {
  const a = await analyze({
    "prisma/schema.prisma": schema,
    "db.ts": `import {PrismaClient as Engine} from '@prisma/client'; export const database=new Engine(); export const user=database.user;`,
    "main.ts": `import {database as store,user as account} from './db';
export async function load(){
 const {user: users}=store;
 const alias=users;
 await alias.findMany({where:{email:'x'},include:{posts:{select:{title:true}}}});
 await account.count();
 const {findFirst: first}=store.user;
 await first();
 return store.$transaction(async tx=>tx.user.update({where:{id:1},data:{email:'y'}}));
}`,
  });
  const model = a.symbols.find((s) => s.kind === "MODEL" && s.name === "User")!;
  const queries = a.edges.filter((e) => e.type === "PRISMA_QUERY");
  expect(queries.map((e) => e.metadata?.operation).sort()).toEqual([
    "count",
    "findFirst",
    "findMany",
    "update",
  ]);
  expect(queries.every((e) => e.target === model.id)).toBe(true);
  expect(
    a.edges.some(
      (e) =>
        e.type === "REFERENCES" &&
        e.target === a.symbols.find((s) => s.qualifiedName === "Post.title")?.id,
    ),
  ).toBe(true);
  expect(a.edges.filter((e) => e.type === "REFERENCES" && e.target === model.id)).toHaveLength(4);
});
it("does not infer Prisma from variable names, shadowed methods or mutable aliases", async () => {
  const a = await analyze({
    "schema.prisma": schema,
    "main.ts": `import {PrismaClient} from '@prisma/client'; const db=new PrismaClient();
const user={findMany(){return []}}; user.findMany();
function fake(user:any){return user.findMany()}
let changed=db.user; changed=user; changed.findMany();
const trueAlias=db.user; trueAlias.findMany();`,
  });
  expect(a.edges.filter((e) => e.type === "PRISMA_QUERY")).toHaveLength(1);
});
it("supports typed delegates, typed client properties and independent custom client schemas", async () => {
  const a = await analyze({
    "a/schema.prisma": schema.replace(
      'provider = "prisma-client-js"',
      'provider = "prisma-client"\n output = "../generated/a"',
    ),
    "b/schema.prisma": schema.replace(
      'provider = "prisma-client-js"',
      'provider = "prisma-client"\n output = "../generated/b"',
    ),
    "main.ts": `import {PrismaClient as A,Prisma} from './generated/a/client';
import {PrismaClient as B} from './generated/b/client';
const dbA=new A(),dbB=new B();dbA.user.findMany();dbB.user.findMany();
function typed(user:Prisma.UserDelegate){return user.count()}
class Service {constructor(private conn:A){} load(){return this.conn.user.findFirst()}}
`,
  });
  const queries = a.edges.filter((e) => e.type === "PRISMA_QUERY");
  expect(queries).toHaveLength(4);
  const paths = queries.map((e) => a.symbols.find((s) => s.id === e.target)?.file);
  expect(paths.filter((p) => p === "a/schema.prisma")).toHaveLength(3);
  expect(paths.filter((p) => p === "b/schema.prisma")).toHaveLength(1);
});
it("joins multifile schema relations and reports missing targets and malformed files", async () => {
  const a = await analyze({
    "prisma/schema.prisma": 'generator client {\n provider = "prisma-client-js"\n}\n',
    "prisma/models/user.prisma": "model User {\n id Int @id\n posts Post[]\n}\n",
    "prisma/models/post.prisma":
      "model Post {\n id Int @id\n user User?\n missing MissingType\n}\n",
    "prisma/broken.prisma": "model Broken {\n bad !@#$\n}\n",
  });
  expect(a.symbols.filter((s) => s.kind === "MODEL")).toHaveLength(2);
  expect(a.edges.filter((e) => e.type === "RELATES_TO")).toHaveLength(2);
  expect(
    a.diagnostics.some(
      (d) => d.file === "prisma/broken.prisma" && d.kind === "SYNTAX_ERROR" && !!d.line,
    ),
  ).toBe(true);
  expect(a.unresolved.some((u) => u.type === "PRISMA_TYPE")).toBe(true);
});
it("passes Prisma symbols and operation metadata through the isolated parser", async () => {
  const a = await analyze(
    {
      "schema.prisma": schema,
      "main.ts":
        "import {PrismaClient} from '@prisma/client';const client=new PrismaClient();const user=client.user;user.findMany();",
    },
    true,
  );
  expect(
    a.edges.some((e) => e.type === "PRISMA_QUERY" && e.metadata?.operation === "findMany"),
  ).toBe(true);
});

it("preserves enums and composite foreign keys without merging ambiguous clients", async () => {
  const a = await analyze({
    "one/schema.prisma":
      'generator client {\n provider = "prisma-client-js"\n}\nenum Role {\n USER\n ADMIN\n}\nmodel User {\n tenant Int\n id Int\n role Role\n @@id([tenant,id])\n}\nmodel Post {\n id Int @id\n tenant Int\n authorId Int\n author User @relation(fields:[tenant,authorId],references:[tenant,id])\n}\n',
    "two/schema.prisma": schema,
    "main.ts":
      "import {PrismaClient} from '@prisma/client';const client=new PrismaClient();client.user.findMany();",
  });
  expect(a.edges.filter((e) => e.type === "FOREIGN_KEY")).toHaveLength(3);
  expect(
    a.edges.some(
      (e) => e.type === "TYPE_OF" && a.symbols.find((s) => s.id === e.target)?.name === "Role",
    ),
  ).toBe(true);
  expect(a.edges.filter((e) => e.type === "PRISMA_QUERY")).toHaveLength(0);
});
it("reports unsupported operations on proven Prisma delegates", async () => {
  const a = await analyze({
    "schema.prisma": schema,
    "main.ts":
      "import {PrismaClient} from '@prisma/client';const client=new PrismaClient();const user=client.user;user[operation]();user.extensionCall();",
  });
  expect(a.unresolved.filter((u) => u.type === "PRISMA_QUERY")).toHaveLength(2);
  expect(a.edges.filter((e) => e.type === "PRISMA_QUERY")).toHaveLength(0);
});

it("recognizes CommonJS client imports but rejects shadowed require", async () => {
  const a = await analyze({
    "schema.prisma": schema,
    "main.cjs": `const {PrismaClient: Engine}=require('@prisma/client'); const store=new Engine(); const user=store.user;user.findMany();
function fake(require){const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.user.findMany();}`,
  });
  expect(a.edges.filter((e) => e.type === "PRISMA_QUERY")).toHaveLength(1);
});
it("does not absorb a nested package schema into its parent's client", async () => {
  const a = await analyze({
    "schema.prisma": schema,
    "nested/package.json": "{}",
    "nested/schema.prisma": "model Other {\n id Int @id\n}\n",
    "main.ts":
      "import {PrismaClient} from '@prisma/client';const db=new PrismaClient();db.other.findMany();db.user.findMany();",
  });
  expect(a.edges.filter((e) => e.type === "PRISMA_QUERY")).toHaveLength(1);
});

it("indexes five models and cross-file references around block comments in the worker", async () => {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile("tests/fixtures/prisma/block-comments/schema.prisma", "utf8");
  const a = await analyze(
    {
      "prisma/schema.prisma": content,
      ...Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [
          `prisma/order${i}.prisma`,
          `model Order${i} {\n id Int @id\n supplierId Int\n supplier Supplier @relation(fields: [supplierId], references: [id])\n}\n`,
        ]),
      ),
      "main.ts":
        "import {PrismaClient} from '@prisma/client';const db=new PrismaClient();const supplier=db.supplier;export function load(){return supplier.findMany()}",
    },
    true,
  );
  expect(a.diagnostics).toEqual([]);
  expect(
    a.symbols.filter((s) => s.kind === "MODEL" && s.file === "prisma/schema.prisma"),
  ).toHaveLength(5);
  const supplier = a.symbols.find((s) => s.kind === "MODEL" && s.name === "Supplier")!;
  expect(supplier.startLine).toBe(5);
  expect(supplier.startColumn).toBe(1);
  expect(a.edges.filter((e) => e.type === "RELATES_TO" && e.target === supplier.id)).toHaveLength(
    8,
  );
  expect(a.edges).toContainEqual(
    expect.objectContaining({
      type: "PRISMA_QUERY",
      target: supplier.id,
      metadata: expect.objectContaining({ operation: "findMany" }),
    }),
  );
});

it.each(["\n", "\r\n"])(
  "preserves Prisma block-comment source coordinates with %j newlines",
  async (newline) => {
    const source = [
      "/* 😀 */ model User {",
      "  /* note */ id Int @id",
      '  value String @default("/* literal */")',
      "}",
    ].join(newline);
    const a = await analyze({ "schema.prisma": source });
    expect(a.diagnostics).toEqual([]);
    const model = a.symbols.find((s) => s.kind === "MODEL")!;
    expect(model.startLine).toBe(1);
    expect(model.startColumn).toBe(source.indexOf("model") + 1);
    const field = a.symbols.find((s) => s.qualifiedName === "User.id")!;
    expect(field.startLine).toBe(2);
    expect(field.startColumn).toBe(14);
    const invalid = await analyze({ "schema.prisma": source.replace("id Int @id", "?? Int @id") });
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "SYNTAX_ERROR", line: 2, column: 14 }),
    );
  },
);

it("reports an unterminated Prisma block comment at its original position", async () => {
  const a = await analyze({
    "schema.prisma": "/* valid */\nmodel User {\n id Int @id\n /** unclosed\n}\n",
  });
  expect(a.diagnostics).toContainEqual(
    expect.objectContaining({ kind: "SYNTAX_ERROR", line: 4, column: 2 }),
  );
  expect(a.symbols.filter((s) => s.kind === "MODEL")).toEqual([]);
});
