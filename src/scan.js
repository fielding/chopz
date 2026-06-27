// Static scan of a skill's files for cheap-attack red flags (THREAT-MODEL #4).
//
// Heuristic, not proof. The job is to catch low-effort attacks and focus a
// human's attention, never to auto-block or to guarantee detection. A careful
// attacker evades this; the invisible-unicode and buried-blob checks pull the
// most weight, because those have no honest reason to appear in a SKILL.md. The
// prompt-injection check is the weakest (a malicious instruction is just natural
// language) and is included as a nudge, not a guarantee.

import { readFileSync } from "node:fs";
import path from "node:path";
import { walkFiles } from "./walk.js";

// Zero-width, bidi-override, and isolate codepoints, plus the BOM (the Trojan
// Source class: instructions a reviewer cannot see). Held as numeric ranges so
// this file contains no literal invisible characters.
const INVISIBLE_RANGES = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
];
const NUL = String.fromCharCode(0);

// ASCII-only regexes for the rest of the checks.
const REGEX_CHECKS = [
  {
    kind: "base64-blob",
    re: /[A-Za-z0-9+/]{60,}={0,2}/,
    why: "long base64 run that could hide a payload",
  },
  {
    kind: "hex-blob",
    re: /\b[0-9a-fA-F]{64,}\b/,
    why: "long hex run that could hide a payload",
  },
  {
    kind: "pipe-to-shell",
    re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|\beval\b|\bbase64\b[^\n|]*\|\s*(?:sh|bash)\b/,
    why: "a download piped into a shell, or eval",
  },
  {
    kind: "sensitive-path",
    re: /(?:~\/\.ssh\b|id_rsa\b|id_ed25519\b|\.aws\/credentials|aws_secret|~\/\.npmrc\b|(?:^|[^.\w])\.env\b|keychain|\.pem\b|private key)/i,
    why: "reads a credential or key path",
  },
  {
    kind: "prompt-injection",
    re: /\b(?:ignore (?:all )?(?:previous|prior|above) (?:instructions|prompts?)|disregard (?:the )?(?:above|previous|prior)|you are now|override your (?:instructions|system)|reveal your (?:system )?prompt)\b/i,
    why: "phrasing that tries to override the agent",
  },
];

// The first invisible codepoint in a string, or null.
function firstInvisible(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    for (const [lo, hi] of INVISIBLE_RANGES) {
      if (c >= lo && c <= hi) return c;
    }
  }
  return null;
}

// Scan one blob of text. Returns findings: { file, line, kind, why, match }.
export function scanText(text, file = "") {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const c of REGEX_CHECKS) {
      const m = c.re.exec(line);
      if (m) findings.push({ file, line: i + 1, kind: c.kind, why: c.why, match: trim(m[0]) });
    }
    const inv = firstInvisible(line);
    if (inv !== null) {
      findings.push({
        file,
        line: i + 1,
        kind: "invisible-unicode",
        why: "zero-width or bidi character a reviewer cannot see",
        match: `U+${inv.toString(16).toUpperCase().padStart(4, "0")}`,
      });
    }
  });
  return findings;
}

// Scan every text file in a skill directory. Binary files are flagged, not read.
// A file that cannot be read is reported (not silently skipped), so the scanner
// never claims "clean" while leaving files uninspected.
export function scanSkill(skillDir) {
  const findings = [];
  let files;
  try {
    files = walkFiles(skillDir);
  } catch (err) {
    // An unreadable directory is reported, never silently skipped, so the
    // scanner never claims a clean result over files it could not read.
    return [
      {
        file: err.path || skillDir,
        line: 0,
        kind: "unreadable",
        why: `could not read a directory (${err.code || err.message}); skill not fully scanned`,
        match: "",
      },
    ];
  }
  for (const rel of files) {
    const abs = path.join(skillDir, rel);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (err) {
      findings.push({ file: rel, line: 0, kind: "unreadable", why: `could not read this file (${err.code || err.message}), not scanned`, match: "" });
      continue;
    }
    if (text.includes(NUL)) {
      findings.push({ file: rel, line: 0, kind: "binary", why: "binary file in a skill (not scannable)", match: "" });
      continue;
    }
    for (const f of scanText(text, rel)) findings.push(f);
  }
  return findings;
}

function trim(s) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}
