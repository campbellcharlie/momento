// Tiny markdown renderer for momento.
//
// Handles the subset that shows up in agent transcripts: headings, fenced
// code blocks, inline code, bold/italic, links, blockquotes, ordered/
// unordered lists, GFM tables, horizontal rules, and the `[term]` markers
// FTS5 snippets use for matched-keyword highlighting.
//
// Everything escapes HTML first; user content never reaches the DOM as
// raw HTML. Output is a single string the caller assigns to innerHTML.

const RE_FENCE = /^```([^\n]*)\n([\s\S]*?)\n```$/;
const RE_FENCE_TILDE = /^~~~([^\n]*)\n([\s\S]*?)\n~~~$/;

export function renderMarkdown(src) {
  if (!src) return "";
  // 1. Pull fenced code blocks out so their internals don't get touched.
  const codeBlocks = [];
  let work = String(src).replace(/\r\n/g, "\n");
  work = work.replace(/```([^\n]*)\n([\s\S]*?)\n```/g, (_, lang, body) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || "").trim(), body });
    return `\u0000CODE${idx}\u0000`;
  });
  work = work.replace(/~~~([^\n]*)\n([\s\S]*?)\n~~~/g, (_, lang, body) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || "").trim(), body });
    return `\u0000CODE${idx}\u0000`;
  });

  // 2. Escape everything else.
  work = escapeHtml(work);

  // 3. Block-level transforms, line-by-line with light state.
  const lines = work.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Code block placeholder.
    const codeMatch = /^\u0000CODE(\d+)\u0000$/.exec(line);
    if (codeMatch) {
      const block = codeBlocks[Number(codeMatch[1])];
      const langClass = block.lang ? ` class="lang-${escapeAttr(block.lang)}"` : "";
      out.push(`<pre><code${langClass}>${escapeHtml(block.body)}</code></pre>`);
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Table: a header line, a separator line of dashes, then data rows.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?\s*$/.test(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const aligns = lines[i + 1].split("|").map((c) => c.trim()).filter(Boolean).map((c) => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      let j = i + 2;
      const bodyRows = [];
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        bodyRows.push(splitTableRow(lines[j]));
        j += 1;
      }
      const ths = headerCells
        .map((c, idx) => `<th style="text-align:${aligns[idx] || "left"}">${inline(c)}</th>`)
        .join("");
      const trs = bodyRows
        .map(
          (row) =>
            `<tr>${row
              .map((c, idx) => `<td style="text-align:${aligns[idx] || "left"}">${inline(c)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      out.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      i = j;
      continue;
    }

    // Blockquote: by this point HTML has been escaped, so the leading `>`
    // shows up as `&gt;`. Match either form so the parser stays correct if
    // a caller ever passes pre-escaped text.
    if (/^(?:&gt;|>)\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^(?:&gt;|>)\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^(?:&gt;|>)\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ol>`);
      continue;
    }

    // Blank line — paragraph break.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: collect contiguous non-block lines.
    const buf = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\u0000CODE\d+\u0000$|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

function splitTableRow(line) {
  // Strip optional leading/trailing pipes, then split.
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function inline(text) {
  // Order matters: protect inline code first, then links, then emphasis,
  // then the FTS5 `[term]` markers.
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, body) => {
    const idx = codes.length;
    codes.push(body);
    return `\u0000IC${idx}\u0000`;
  });
  // Links [text](href). Skip if it looks like an FTS marker (no parens).
  s = s.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, label, href, title) => {
      const safeHref = sanitizeUrl(href);
      const t = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${safeHref}" rel="noopener noreferrer"${t}>${label}</a>`;
    },
  );
  // Bold then italic.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
  // Auto-link bare URLs. Skip if the URL is already inside an attribute or
  // tag (preceded by `"` or `>`), and exclude `"` from the URL character
  // class so it never extends into HTML we just produced.
  s = s.replace(/(?<![">=])(https?:\/\/[^\s<"]+)/g, (m) => `<a href="${escapeAttr(m)}" rel="noopener noreferrer">${m}</a>`);
  // FTS5 highlight markers from search snippets: [term] → <mark>term</mark>.
  s = s.replace(/\[([^\[\]\n]+?)\]/g, "<mark>$1</mark>");
  // Restore inline code.
  s = s.replace(/\u0000IC(\d+)\u0000/g, (_, idx) => `<code>${escapeHtml(codes[Number(idx)])}</code>`);
  return s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeUrl(href) {
  const trimmed = String(href).trim();
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return "#";
  return escapeAttr(trimmed);
}
