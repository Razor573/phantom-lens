// electron/fileTextExtractor.ts
//
// Extract readable text from user-attached files so their contents can be
// sent to the model as context. Inspired by natively's SafeDocumentTextExtractor
// but kept dependency-light: pdf-parse (pdf), mammoth (docx), jszip (pptx),
// plain UTF-8 reads for text formats.

import * as fs from "fs";
import * as path from "path";

/** Max file size accepted for text extraction (15 MB). */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Max characters kept per file before truncation. */
export const MAX_CHARS_PER_FILE = 100_000;

/** Extensions we know how to extract text from. */
export const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
]);

/** File-dialog filter groups for the attach picker. */
export const ATTACH_DIALOG_FILTERS: Array<{ name: string; extensions: string[] }> = [
  { name: "Documents", extensions: ["pdf", "docx", "pptx", "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "log"] },
  { name: "PDF", extensions: ["pdf"] },
  { name: "Word", extensions: ["docx"] },
  { name: "PowerPoint", extensions: ["pptx"] },
  { name: "Text", extensions: ["txt", "md", "markdown", "csv", "tsv", "log"] },
  { name: "All Files", extensions: ["*"] },
];

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS_PER_FILE) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_CHARS_PER_FILE) + "\n\n[... content truncated: file too long ...]",
    truncated: true,
  };
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // pdf-parse v1: require('pdf-parse')(buffer) -> { text }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(buffer);
  const text = (data?.text || "").trim();
  if (!text) throw new Error("No readable text found in PDF (it may be scanned images).");
  return text;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  const text = (result?.value || "").trim();
  if (!text) throw new Error("No readable text found in document.");
  return text;
}

async function extractPptx(buffer: Buffer): Promise<string> {
  // pptx is a zip of slide XML files; visible text lives in <a:t> elements.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || "0", 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || "0", 10);
      return na - nb;
    });
  if (slidePaths.length === 0) throw new Error("No slides found in presentation.");
  const slides: string[] = [];
  for (const slidePath of slidePaths) {
    const xml = await zip.files[slidePath].async("string");
    const texts: string[] = [];
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const t = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
      if (t) texts.push(t);
    }
    const num = slidePath.match(/slide(\d+)\.xml$/)?.[1];
    slides.push(`--- Slide ${num} ---\n${texts.join("\n")}`);
  }
  const text = slides.join("\n\n").trim();
  if (!text.replace(/--- Slide \d+ ---/g, "").trim()) {
    throw new Error("No readable text found in presentation.");
  }
  return text;
}

function extractPlainText(buffer: Buffer, fileName: string): string {
  if (buffer.length === 0) throw new Error(`${fileName} is empty.`);
  // Strip UTF-8 BOM if present
  let text = buffer.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.trim();
  if (!text) throw new Error(`${fileName} is empty.`);
  return text;
}

export async function extractFileText(
  filePath: string
): Promise<{ text: string; truncated: boolean }> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (!isSupportedFile(filePath)) {
    throw new Error(`Unsupported file type "${ext || "(none)"}".`);
  }

  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${fileName} is larger than 15 MB.`);
  }

  const buffer = await fs.promises.readFile(filePath);
  let text: string;
  if (ext === ".pdf") {
    text = await extractPdf(buffer);
  } else if (ext === ".docx") {
    text = await extractDocx(buffer);
  } else if (ext === ".pptx") {
    text = await extractPptx(buffer);
  } else {
    text = extractPlainText(buffer, fileName);
  }
  return truncate(text);
}
