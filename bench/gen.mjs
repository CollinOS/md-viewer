// Generates large markdown files for performance testing.
import fs from "node:fs";
import path from "node:path";

const out = path.join(import.meta.dirname, "files");
fs.mkdirSync(out, { recursive: true });

const para = (i) =>
  `Paragraph ${i} has **bold text**, some *emphasis*, a [link](https://example.com/${i}) and \`inline code\`. ` +
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

const code = (i) =>
  "```rust\n" +
  `fn compute_${i}(input: &[u32]) -> u64 {\n    let mut total = 0u64;\n    for (idx, v) in input.iter().enumerate() {\n        if idx % 2 == 0 { total += *v as u64 * 3; } else { total ^= *v as u64; }\n    }\n    total // done\n}\n` +
  "```";

const table = (i) => `| Col A | Col B | Col C |\n|---|---|---|\n${Array.from({ length: 5 }, (_, r) => `| ${i}-${r} | value ${r} | **${r * i}** |`).join("\n")}`;

function build(targetBytes, withCode = true) {
  const parts = [];
  let size = 0;
  for (let i = 0; size < targetBytes; i++) {
    const block = [
      `## Section ${i}`,
      para(i),
      `- item one ${i}\n- item two\n  - nested ${i}\n- [ ] task ${i}`,
      i % 3 === 0 && withCode ? code(i) : para(i + 0.5),
      i % 5 === 0 ? table(i) : "> A quote in section " + i,
    ].join("\n\n");
    parts.push(block);
    size += block.length + 2;
  }
  return "# Large document\n\n" + parts.join("\n\n") + "\n";
}

fs.writeFileSync(path.join(out, "readme-20k.md"), build(20_000));
fs.writeFileSync(path.join(out, "large-1mb.md"), build(1_000_000));
fs.writeFileSync(path.join(out, "huge-5mb.md"), build(5_000_000));
fs.writeFileSync(path.join(out, "code-heavy-500k.md"), Array.from({ length: 1200 }, (_, i) => code(i)).join("\n\n"));
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
