/**
 * Converts stray LaTeX commands in plain text to their Unicode equivalents.
 *
 * The model keeps emitting LaTeX (\\times, \\div, \\text{M}, \\% etc.) outside
 * of $...$ math delimiters despite prompt instructions. KaTeX only renders
 * inside delimiters, so these leak through as raw unreadable text.
 *
 * This sanitizer splits content into math segments (inside $...$/$$...$$,
 * left untouched for KaTeX) and text segments (LaTeX commands converted to
 * Unicode). It runs before ReactMarkdown in MarkdownSection.
 */

/** LaTeX command -> Unicode replacement for plain-text segments. */
const COMMAND_REPLACEMENTS: Array<[RegExp, string]> = [
  // \text{...} -> inner content (e.g. \text{M} -> M)
  [/\\text\{([^}]*)\}/g, "$1"],
  [/\\mathrm\{([^}]*)\}/g, "$1"],
  [/\\textbf\{([^}]*)\}/g, "$1"],
  [/\\textit\{([^}]*)\}/g, "$1"],
  // Common symbols
  [/\\times/g, "×"],
  [/\\div/g, "÷"],
  [/\\pm/g, "±"],
  [/\\mp/g, "∓"],
  [/\\cdot/g, "·"],
  [/\\leq/g, "≤"],
  [/\\geq/g, "≥"],
  [/\\neq/g, "≠"],
  [/\\approx/g, "≈"],
  [/\\equiv/g, "≡"],
  [/\\infty/g, "∞"],
  [/\\rightarrow/g, "→"],
  [/\\leftarrow/g, "←"],
  [/\\Rightarrow/g, "⟹"],
  [/\\Leftarrow/g, "⟸"],
  // Escaped special chars -> literal (in text segments, \$ is safe now
  // that math splitting already ran)
  [/\\\$/g, "$"],
  [/\\%/g, "%"],
  [/\\&/g, "&"],
  [/\\#/g, "#"],
  [/\\_/g, "_"],
  // \frac{a}{b} -> a/b in plain text
  [/\\[dt]?frac\{([^}]*)\}\{([^}]*)\}/g, "$1/$2"],
  // \sqrt{x} -> √x
  [/\\sqrt\{([^}]*)\}/g, "√$1"],
  [/\\sqrt/g, "√"],
  // Superscripts/subscripts: x^{2} -> x² (single digit only, else keep readable)
  [/\\^{([^}]*)}/g, "^$1"],
  [/\\_/g, "_"],
  // Line breaks
  [/\\\\(\s*\n|\s)/g, " "],
  // Mangled currency: \72.00 (backslash-digit from a broken \$) -> $72.00
  [/\\(\d)/g, "$$$1"],
  // Remaining unknown commands: strip the backslash, keep the name readable
  // (e.g. \foo -> foo) rather than leaving raw LaTeX visible.
  [/\\([a-zA-Z]+)/g, "$1"],
];

/**
 * Split content into segments, marking which are inside $...$ or $$...$$
 * math delimiters. Escaped \$ and lone $ (currency like $18,000 with no
 * closing delimiter) are treated as plain text.
 */
function splitMathSegments(content: string): Array<{ text: string; isMath: boolean }> {
  const segments: Array<{ text: string; isMath: boolean }> = [];
  let i = 0;
  let current = "";
  const n = content.length;

  const flush = (isMath: boolean) => {
    if (current) {
      segments.push({ text: current, isMath });
      current = "";
    }
  };

  while (i < n) {
    const ch = content[i];

    // Escaped dollar: literal, not a delimiter
    if (ch === "\\" && i + 1 < n && content[i + 1] === "$") {
      current += "\\$";
      i += 2;
      continue;
    }

    if (ch === "$") {
      // Check for $$...$$ display math
      if (i + 1 < n && content[i + 1] === "$") {
        const close = content.indexOf("$$", i + 2);
        if (close !== -1) {
          flush(false);
          segments.push({ text: content.slice(i, close + 2), isMath: true });
          i = close + 2;
          continue;
        }
        // No closing $$: treat as literal
        current += "$$";
        i += 2;
        continue;
      }
      // Single $...$: find closing $ that isn't escaped
      let j = i + 1;
      let found = -1;
      while (j < n) {
        if (content[j] === "\\" && j + 1 < n && content[j + 1] === "$") {
          j += 2;
          continue;
        }
        if (content[j] === "$") {
          // Avoid matching $$ as a close for single $
          if (j + 1 < n && content[j + 1] === "$") break;
          found = j;
          break;
        }
        // A newline before any closing $ means this was a currency $, not math
        if (content[j] === "\n") break;
        j++;
      }
      if (found !== -1) {
        const inner = content.slice(i + 1, found);
        // Heuristic: real inline math contains a backslash command, or is a
        // short expression. A lone $ with plain words after it ("$ and then")
        // is not math - treat the $ as literal.
        const looksLikeMath = /\\/.test(inner) || /^[^a-zA-Z]{0,40}$/.test(inner.trim());
        if (looksLikeMath && inner.trim().length > 0) {
          flush(false);
          segments.push({ text: content.slice(i, found + 1), isMath: true });
          i = found + 1;
          continue;
        }
      }
      // Not math: literal dollar sign
      current += "$";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  flush(false);
  return segments;
}

/** Apply command replacements to a plain-text segment. */
function sanitizeTextSegment(text: string): string {
  let out = text;
  for (const [pattern, replacement] of COMMAND_REPLACEMENTS) {
    out = out.replace(pattern, replacement as string);
  }
  // Clean up stray empty delimiters left behind, e.g. "£60.00M$" -> "£60.00M"
  // (a trailing $ with no opener after sanitization).
  out = out.replace(/\$(\s|$)/g, "$1");
  return out;
}

/**
 * Main entry: sanitize stray LaTeX in plain text while preserving
 * legitimate $...$/$$...$$ math blocks for KaTeX rendering.
 */
export function sanitizeLatex(content: string | null | undefined): string {
  if (!content) return content ?? "";
  const segments = splitMathSegments(content);
  return segments
    .map((seg) => (seg.isMath ? seg.text : sanitizeTextSegment(seg.text)))
    .join("");
}
