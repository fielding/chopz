// Minimal SKILL.md frontmatter reader -- just enough to extract `requires:`.
//
// chopz keeps zero runtime deps (THREAT-MODEL #7), so it does not pull a YAML
// parser. It only needs one field, a list of skill names, in the simple forms a
// SKILL.md actually uses: a block list, an inline flow list, or a single scalar.
// Anything fancier than that is not something a `requires:` line should contain.

import { readFileSync } from "node:fs";

// Return the `requires:` list from SKILL.md text, or [] if absent.
export function parseRequires(content) {
  const fm = frontmatterBlock(content);
  if (fm === null) return [];

  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^requires:\s*(.*)$/);
    if (!m) continue;

    const inline = stripComment(m[1]).trim();
    if (inline.startsWith("[")) {
      return inline
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map(cleanItem)
        .filter(Boolean);
    }
    if (inline) return [cleanItem(inline)].filter(Boolean);

    // Block list: indented "- name" lines until the block ends.
    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      const lm = lines[j].match(/^\s*-\s+(.+)$/);
      if (!lm) break; // a blank line or a new key ends the list
      const item = cleanItem(lm[1]);
      if (item) items.push(item);
    }
    return items;
  }
  return [];
}

// Read `requires:` from a SKILL.md on disk; [] if the file is missing.
export function readRequires(skillMdPath) {
  let content;
  try {
    content = readFileSync(skillMdPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return parseRequires(content);
}

function frontmatterBlock(content) {
  const m = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function stripComment(s) {
  return s.replace(/\s+#.*$/, "");
}

function cleanItem(s) {
  return stripComment(s)
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}
