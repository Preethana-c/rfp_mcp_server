import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import express from "express"
import multer from "multer"
import mammoth from "mammoth"
import AdmZip from "adm-zip"
import { execSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { join, extname, basename } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import { randomBytes } from "crypto"
import { z } from "zod"

const oauthClients = new Map()
const oauthCodes   = new Map()

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY       = process.env.API_KEY || "change-me"
const PORT          = process.env.PORT || 3000
const PUBLIC_URL    = process.env.PUBLIC_URL || `http://localhost:${PORT}`

const SAMPLES_DIR   = join(__dirname, "samples")
const TEMPLATES_DIR = join(__dirname, "templates")
const OUTPUT_DIR    = "/tmp/rfp_output"

for (const dir of [SAMPLES_DIR, TEMPLATES_DIR, OUTPUT_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function checkApiKey(req, res) {
  const auth = req.headers.authorization || ""
  const key  = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.api_key
  if (key !== API_KEY) {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`)
    res.status(401).json({ error: "Invalid API key" })
    return false
  }
  return true
}

// ── XML helper ────────────────────────────────────────────────────────────────

function xmlEscape(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

// ── YAML frontmatter parser ───────────────────────────────────────────────────

function parseFrontmatter(markdown) {
  const m = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*["']?(.*?)["']?\s*$/)
    if (kv) data[kv[1]] = kv[2].trim()
  }
  return data
}

// ── Build proposal by cloning template ───────────────────────────────────────
// Strategy: keep the template's cover page + TOC (everything before the first
// Heading1/Heading2 paragraph), replace all section content with the
// pandoc-generated proposal, and substitute cover page placeholder text.
// This preserves the logo, colored shapes, header, footer, and styles exactly.

function buildProposalFromTemplate(pandocDocxPath, tmplPath, outputPath, coverData = {}) {
  const tmplZip   = new AdmZip(tmplPath)
  const pandocZip = new AdmZip(pandocDocxPath)

  // ── Extract pandoc body (strip pandoc's final sectPr) ────────────────────
  const pandocDocXml    = pandocZip.getEntry("word/document.xml").getData().toString("utf-8")
  const pandocBodyMatch = pandocDocXml.match(/<w:body>([\s\S]*?)<\/w:body>/)
  if (!pandocBodyMatch) throw new Error("Cannot parse pandoc output body")
  let pandocBody = pandocBodyMatch[1]
    .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/, "")
    .trim()

  // Normalise pandoc's default style names to match the Qmax template's style IDs.
  // Pandoc without --reference-doc uses "Heading 1" (space); the template uses "Heading1".
  pandocBody = pandocBody
    .replace(/w:val="Heading 1"/g,  'w:val="Heading1"')
    .replace(/w:val="Heading 2"/g,  'w:val="Heading2"')
    .replace(/w:val="Heading 3"/g,  'w:val="Heading3"')
    .replace(/w:val="Heading 4"/g,  'w:val="Heading4"')
    .replace(/w:val="Body Text"/g,  'w:val="Normal"')
    .replace(/w:val="First Paragraph"/g, 'w:val="Normal"')

  // ── Clone template and find the cut point ────────────────────────────────
  let tmplDocXml     = tmplZip.getEntry("word/document.xml").getData().toString("utf-8")
  const bodyOpenIdx  = tmplDocXml.indexOf("<w:body>") + "<w:body>".length
  const bodyCloseIdx = tmplDocXml.lastIndexOf("</w:body>")
  const tmplBody     = tmplDocXml.substring(bodyOpenIdx, bodyCloseIdx)
  const finalSectPr  = (tmplBody.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/) ?? [])[0] ?? ""

  // The cover page + TOC section ends just before the first Heading1/Heading2
  // paragraph in the template. Find that style reference, then look backwards
  // to the enclosing <w:p> opening tag — that is the cut point.
  const firstH1Idx  = tmplBody.indexOf('<w:pStyle w:val="Heading1"')
  const firstH2Idx  = tmplBody.indexOf('<w:pStyle w:val="Heading2"')
  let firstHdgIdx   = -1
  if (firstH1Idx !== -1 && firstH2Idx !== -1) firstHdgIdx = Math.min(firstH1Idx, firstH2Idx)
  else if (firstH1Idx !== -1) firstHdgIdx = firstH1Idx
  else if (firstH2Idx !== -1) firstHdgIdx = firstH2Idx

  let coverEndIdx = 0
  if (firstHdgIdx !== -1) {
    const before = tmplBody.substring(0, firstHdgIdx)
    let pIdx = before.lastIndexOf("<w:p ")
    if (pIdx === -1) pIdx = before.lastIndexOf("<w:p>")
    if (pIdx !== -1) coverEndIdx = pIdx
  }

  // ── Apply cover page text substitutions ──────────────────────────────────
  let coverAndToc = tmplBody.substring(0, coverEndIdx)

  if (coverData.title) {
    coverAndToc = coverAndToc.replace(/Project Title/g, xmlEscape(coverData.title))
  }
  if (coverData.nature) {
    coverAndToc = coverAndToc.replace(/\(Project Nature description\)/g, xmlEscape(coverData.nature))
  }
  if (coverData.client) {
    const cXml = xmlEscape(coverData.client)
    coverAndToc = coverAndToc.replace(/Customer name/g, cXml)
    coverAndToc = coverAndToc.replace(/Customer Name/g, cXml)
  }
  if (coverData.docNumber) {
    coverAndToc = coverAndToc.replace(/QMX-PRO-2026-SLMK-001/g, xmlEscape(coverData.docNumber))
  }
  if (coverData.date) {
    coverAndToc = coverAndToc.replace(/June 10, 2026/g, xmlEscape(coverData.date))
  }

  // ── Assemble: cover+TOC  +  pandoc content  +  template page settings ────
  const newBody   = coverAndToc + "\n" + pandocBody + "\n" + finalSectPr
  const newDocXml =
    tmplDocXml.substring(0, bodyOpenIdx) + "\n" +
    newBody + "\n" +
    tmplDocXml.substring(bodyCloseIdx)

  tmplZip.updateFile("word/document.xml", Buffer.from(newDocXml, "utf-8"))

  // ── Swap in pandoc's clean settings.xml (removes Word compat flags) ───────
  const cleanSettings = pandocZip.getEntry("word/settings.xml")?.getData()
  if (cleanSettings) {
    if (tmplZip.getEntry("word/settings.xml")) tmplZip.updateFile("word/settings.xml", cleanSettings)
    else tmplZip.addFile("word/settings.xml", cleanSettings)
  }

  // ── Copy pandoc inline images (charts, embedded pics from markdown) ───────
  for (const entry of pandocZip.getEntries()) {
    if (entry.entryName.startsWith("word/media/") && !tmplZip.getEntry(entry.entryName)) {
      tmplZip.addFile(entry.entryName, entry.getData())
    }
  }

  // ── Apply table borders ───────────────────────────────────────────────────
  const merged = tmplZip.getEntry("word/document.xml").getData().toString("utf-8")
  tmplZip.updateFile("word/document.xml", Buffer.from(_applyTableBordersXml(merged), "utf-8"))

  tmplZip.writeZip(outputPath)
}

// ── Template asset injection (legacy fallback) ────────────────────────────────
// Kept as fallback in case buildProposalFromTemplate fails.

const HEADER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"
const FOOTER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"
const HEADER_CT  = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"
const FOOTER_CT  = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"

function injectTemplateAssets(generatedPath, templatePath) {
  const genZip  = new AdmZip(generatedPath)
  const tmplZip = new AdmZip(templatePath)

  // Index all template entries for O(1) lookup
  const tmpl = new Map()
  tmplZip.getEntries().forEach(e => tmpl.set(e.entryName, e))

  // ── Parse template document relationships ────────────────────────────────
  const tmplDocRels = tmpl.get("word/_rels/document.xml.rels")?.getData().toString("utf-8") ?? ""
  const tmplDocXml  = tmpl.get("word/document.xml")?.getData().toString("utf-8") ?? ""

  // Collect header/footer relationship nodes from template
  const hfRelNodes = []
  for (const m of tmplDocRels.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    if (/\/(header|footer)"/.test(m[1])) hfRelNodes.push(m[1])
  }
  if (hfRelNodes.length === 0) {
    // Template has no header/footer — still fix table borders
    _applyTableBorders(genZip)
    genZip.writeZip(generatedPath)
    return
  }

  // Build old-rId → { newId, target } map  (use rId200+ to avoid pandoc conflicts)
  const docIdMap = new Map()
  let nextDocId = 200
  for (const attrs of hfRelNodes) {
    const oldId  = attrs.match(/\bId="([^"]+)"/)?.[1]
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1]
    if (oldId && target) docIdMap.set(oldId, { newId: `rId${nextDocId++}`, target })
  }

  // Map old header/footer rIds → their w:type (default / first / even)
  // from the template's sectPr
  const hfTypeMap = new Map()
  for (const rx of [
    /<w:(header|footer)Reference\s+w:type="([^"]+)"\s+r:id="([^"]+)"/g,
    /<w:(header|footer)Reference\s+r:id="([^"]+)"\s+w:type="([^"]+)"/g,
  ]) {
    for (const m of tmplDocXml.matchAll(rx)) {
      const [, tag, a, b] = m
      const [wType, rId] = rx.source.startsWith(/<w/)
        ? [a, b]   // type first
        : [b, a]   // rId first
      if (!hfTypeMap.has(rId)) hfTypeMap.set(rId, { tagName: tag, type: wType })
    }
  }
  // Simpler fallback parse that works regardless of attribute order
  for (const m of tmplDocXml.matchAll(/<w:(header|footer)Reference\b([^/]*)\//g)) {
    const tag   = m[1]
    const attrs = m[2]
    const rId   = attrs.match(/r:id="([^"]+)"/)?.[1]
    const type  = attrs.match(/w:type="([^"]+)"/)?.[1]
    if (rId && type && !hfTypeMap.has(rId)) hfTypeMap.set(rId, { tagName: tag, type })
  }

  // ── Process each header/footer file ─────────────────────────────────────
  const mediaToAdd = new Map()   // destPath → Buffer
  let nextImgId = 300

  for (const [oldId, { newId, target }] of docIdMap) {
    const hfPath     = `word/${target}`
    const hfName     = target.split("/").pop()
    const hfRelsPath = `word/_rels/${hfName}.rels`

    let hfXml = tmpl.get(hfPath)?.getData().toString("utf-8")
    if (!hfXml) continue

    // Process image/media references inside this header/footer
    const hfRelsRaw = tmpl.get(hfRelsPath)?.getData().toString("utf-8") ?? ""
    const imgIdMap  = new Map()  // old img rId → new img rId

    if (hfRelsRaw) {
      let newHfRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`

      for (const m of hfRelsRaw.matchAll(/<Relationship\b([^>]*)\/>/g)) {
        const a        = m[1]
        const imgOld   = a.match(/\bId="([^"]+)"/)?.[1]
        const imgTgt   = a.match(/\bTarget="([^"]+)"/)?.[1]
        const imgType  = a.match(/\bType="([^"]+)"/)?.[1]
        if (!imgOld || !imgTgt || !imgType) continue

        const imgNew    = `rId${nextImgId++}`
        const imgFname  = imgTgt.split("/").pop()
        const newTarget = `media/tpl_${imgFname}`

        imgIdMap.set(imgOld, imgNew)

        // Copy image buffer from template (try multiple path forms)
        const imgBuf = tmpl.get(`word/${imgTgt}`)?.getData()
                    ?? tmpl.get(`word/media/${imgFname}`)?.getData()
        if (imgBuf) mediaToAdd.set(`word/${newTarget}`, imgBuf)

        newHfRels += `  <Relationship Id="${imgNew}" Type="${imgType}" Target="${newTarget}"/>\n`
      }
      newHfRels += `</Relationships>`
      genZip.addFile(hfRelsPath, Buffer.from(newHfRels, "utf-8"))

      // Remap image IDs inside header/footer XML
      for (const [imgOld, imgNew] of imgIdMap) {
        hfXml = hfXml
          .replaceAll(`r:id="${imgOld}"`,    `r:id="${imgNew}"`)
          .replaceAll(`r:embed="${imgOld}"`, `r:embed="${imgNew}"`)
      }
    }

    genZip.addFile(hfPath, Buffer.from(hfXml, "utf-8"))
  }

  // ── Add media files ──────────────────────────────────────────────────────
  for (const [path, buf] of mediaToAdd) genZip.addFile(path, buf)

  // ── Copy theme (fonts and colours) from template ─────────────────────────
  const themeBuf = tmpl.get("word/theme/theme1.xml")?.getData()
  if (themeBuf) {
    if (genZip.getEntry("word/theme/theme1.xml"))
      genZip.updateFile("word/theme/theme1.xml", themeBuf)
    else
      genZip.addFile("word/theme/theme1.xml", themeBuf)
  }

  // ── Copy styles (heading, paragraph, table, character styles) ─────────────
  // This ensures body text, headings, and tables use the template's exact
  // fonts, colors, and sizes — not pandoc defaults.
  const stylesBuf = tmpl.get("word/styles.xml")?.getData()
  if (stylesBuf) {
    if (genZip.getEntry("word/styles.xml"))
      genZip.updateFile("word/styles.xml", stylesBuf)
    else
      genZip.addFile("word/styles.xml", stylesBuf)
  }

  // ── Copy numbering (list bullet/indent styles) ────────────────────────────
  const numBuf = tmpl.get("word/numbering.xml")?.getData()
  if (numBuf) {
    if (genZip.getEntry("word/numbering.xml"))
      genZip.updateFile("word/numbering.xml", numBuf)
    else
      genZip.addFile("word/numbering.xml", numBuf)
  }

  // ── Copy font table (embedded font references) ────────────────────────────
  const fontBuf = tmpl.get("word/fontTable.xml")?.getData()
  if (fontBuf) {
    if (genZip.getEntry("word/fontTable.xml"))
      genZip.updateFile("word/fontTable.xml", fontBuf)
    else
      genZip.addFile("word/fontTable.xml", fontBuf)
  }

  // ── Update [Content_Types].xml ───────────────────────────────────────────
  let ctXml = genZip.getEntry("[Content_Types].xml")?.getData().toString("utf-8") ?? ""
  for (const { target } of docIdMap.values()) {
    const ct       = target.includes("header") ? HEADER_CT : FOOTER_CT
    const partName = `/word/${target}`
    if (!ctXml.includes(partName))
      ctXml = ctXml.replace("</Types>", `  <Override PartName="${partName}" ContentType="${ct}"/>\n</Types>`)
  }
  genZip.updateFile("[Content_Types].xml", Buffer.from(ctXml, "utf-8"))

  // ── Update word/_rels/document.xml.rels ─────────────────────────────────
  const newRelLines = []
  for (const [, { newId, target }] of docIdMap) {
    const relType = target.includes("header") ? HEADER_REL : FOOTER_REL
    newRelLines.push(`  <Relationship Id="${newId}" Type="${relType}" Target="${target}"/>`)
  }
  let genDocRels = genZip.getEntry("word/_rels/document.xml.rels")?.getData().toString("utf-8") ?? ""
  genDocRels = genDocRels.replace("</Relationships>", newRelLines.join("\n") + "\n</Relationships>")
  genZip.updateFile("word/_rels/document.xml.rels", Buffer.from(genDocRels, "utf-8"))

  // ── Update document.xml sectPr ───────────────────────────────────────────
  let docXml = genZip.getEntry("word/document.xml")?.getData().toString("utf-8") ?? ""

  // Strip old references
  docXml = docXml
    .replace(/<w:headerReference[^/]*\/>/g, "")
    .replace(/<w:footerReference[^/]*\/>/g, "")
    .replace(/<w:titlePg\/>/g, "")

  // Build new headerReference / footerReference elements
  const hfElems = []
  for (const [oldId, { newId, target }] of docIdMap) {
    const info = hfTypeMap.get(oldId) ?? {
      tagName: target.includes("header") ? "header" : "footer",
      type: "default"
    }
    hfElems.push(`  <w:${info.tagName}Reference w:type="${info.type}" r:id="${newId}"/>`)
  }
  if ([...hfTypeMap.values()].some(v => v.type === "first")) hfElems.push("  <w:titlePg/>")

  // Copy page size and margins from template
  const tmplPgSz  = tmplDocXml.match(/<w:pgSz\b[^/]*\/>/)?.[0]  ?? ""
  const tmplPgMar = tmplDocXml.match(/<w:pgMar\b[^/]*\/>/)?.[0] ?? ""
  docXml = docXml.replace(/<w:pgSz\b[^/]*\/>/g, "").replace(/<w:pgMar\b[^/]*\/>/g, "")

  const sectPrInsert = [...hfElems, tmplPgSz, tmplPgMar].filter(Boolean).join("\n")
  if (docXml.includes("</w:sectPr>")) {
    docXml = docXml.replace("</w:sectPr>", sectPrInsert + "\n</w:sectPr>")
  } else {
    docXml = docXml.replace("</w:body>", `<w:sectPr>\n${sectPrInsert}\n</w:sectPr>\n</w:body>`)
  }

  // ── Fix table borders (inline) ───────────────────────────────────────────
  docXml = _applyTableBordersXml(docXml)

  genZip.updateFile("word/document.xml", Buffer.from(docXml, "utf-8"))
  genZip.writeZip(generatedPath)
}

function _applyTableBordersXml(xml) {
  const borders =
    "<w:tblBorders>" +
    '<w:top    w:val="single" w:sz="6" w:space="0" w:color="404040"/>' +
    '<w:left   w:val="single" w:sz="6" w:space="0" w:color="404040"/>' +
    '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="404040"/>' +
    '<w:right  w:val="single" w:sz="6" w:space="0" w:color="404040"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="404040"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="404040"/>' +
    "</w:tblBorders>"
  return xml
    .replace(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/g, "")
    .replace(/<w:tblPr>/g, "<w:tblPr>" + borders)
}

function _applyTableBorders(zip) {
  const entry = zip.getEntry("word/document.xml")
  if (!entry) return
  const patched = _applyTableBordersXml(entry.getData().toString("utf-8"))
  zip.updateFile("word/document.xml", Buffer.from(patched, "utf-8"))
}

// ── MCP server factory ────────────────────────────────────────────────────────
// One McpServer instance per request (stateless HTTP transport pattern)

function createMcpServer() {
  const server = new McpServer({ name: "rfp-docs", version: "1.0.0" })

  // ── Tool: list_samples ──────────────────────────────────────────────────────
  server.tool(
    "list_samples",
    "List all of the company's past proposal documents stored on the server — these are proposals the company has previously written and submitted, used as style and structure references when drafting new proposals (.docx, .pdf, .txt)",
    {},
    async () => {
      const files = readdirSync(SAMPLES_DIR)
        .filter(f => [".docx", ".pdf", ".txt", ".md"].includes(extname(f).toLowerCase()))
        .sort()

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No samples uploaded yet. Use POST /upload/sample to add .docx files." }] }
      }
      return { content: [{ type: "text", text: files.join("\n") }] }
    }
  )

  // ── Tool: read_sample ───────────────────────────────────────────────────────
  server.tool(
    "read_sample",
    "Extract the full text from one of the company's past proposal documents. Use this to learn the company's writing style, tone, team/org structure presentation, and section format before drafting a new proposal. These are NOT RFP documents — they are the company's own previously submitted proposals.",
    { filename: z.string().describe("Filename from list_samples, e.g. Proposal_01_SmartMeterFirmware.docx") },
    async ({ filename }) => {
      const safeName = basename(filename)
      const path = join(SAMPLES_DIR, safeName)

      if (!existsSync(path)) {
        return { content: [{ type: "text", text: `Not found: ${safeName}. Call list_samples to see available files.` }] }
      }

      const ext = extname(safeName).toLowerCase()

      if (ext === ".docx") {
        const result = await mammoth.extractRawText({ path })
        const text = result.value.trim()
        return { content: [{ type: "text", text: text || "(document appears empty)" }] }
      }

      if (ext === ".txt" || ext === ".md") {
        const text = readFileSync(path, "utf-8")
        return { content: [{ type: "text", text }] }
      }

      return { content: [{ type: "text", text: `Cannot extract text from ${ext} files. Upload .docx or .txt samples for best results.` }] }
    }
  )

  // ── Tool: read_template ─────────────────────────────────────────────────────
  // Returns the template_structure.md file (clean section skeleton) so Claude
  // knows exactly what sections, heading levels, and table columns to write.
  // The .docx template is used separately for visual generation (logo, header,
  // footer, cover page, styles) — Claude never needs to read the .docx directly.
  server.tool(
    "read_template",
    "Read the Qmax proposal template structure — returns every section name, heading level, and table column layout Claude must follow when writing a proposal. Call this first before writing anything.",
    {},
    async () => {
      const mdPath   = join(TEMPLATES_DIR, "template_structure.md")
      const docxFiles = readdirSync(TEMPLATES_DIR).filter(f => extname(f).toLowerCase() === ".docx")

      if (!existsSync(mdPath) && docxFiles.length === 0) {
        return { content: [{ type: "text", text: "No template found. Upload template_structure.md and/or a .docx template." }] }
      }

      // Prefer the clean markdown structure file
      if (existsSync(mdPath)) {
        const mdContent = readFileSync(mdPath, "utf-8")
        const output = [
          "=== QMAX PROPOSAL TEMPLATE ===",
          "",
          "RULES — follow these exactly:",
          "1. Write a YAML frontmatter block FIRST (see template below for the fields)",
          "2. Use # for main sections (Heading1 style), ## for subsections (Heading2), ### for sub-subsections",
          "3. Use the EXACT section names below — character for character, including numbers",
          "4. Use | table | markdown syntax — exact column headers as shown below",
          "5. Do NOT write a document title heading — cover page comes from frontmatter",
          "6. Do NOT write a Table of Contents — the Word template has one that auto-updates",
          "7. Fill EVERY field — zero placeholders, zero generic sentences",
          "",
          "=== TEMPLATE STRUCTURE (copy this skeleton, fill in real content) ===",
          "",
          mdContent
        ].join("\n")
        return { content: [{ type: "text", text: output }] }
      }

      // Fallback: extract text from .docx
      const tmplPath  = join(TEMPLATES_DIR, docxFiles[0])
      const textResult = await mammoth.extractRawText({ path: tmplPath })
      return { content: [{ type: "text", text: textResult.value.trim() }] }
    }
  )

  // ── Tool: list_templates ────────────────────────────────────────────────────
  server.tool(
    "list_templates",
    "List available branded .docx proposal templates on the server",
    {},
    async () => {
      const files = readdirSync(TEMPLATES_DIR)
        .filter(f => extname(f).toLowerCase() === ".docx")
        .sort()

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No templates uploaded yet. Use POST /upload/template to add company-template.docx." }] }
      }
      return { content: [{ type: "text", text: files.join("\n") }] }
    }
  )

  // ── Tool: generate_proposal_docx ────────────────────────────────────────────
  server.tool(
    "generate_proposal_docx",
    "Convert the final proposal markdown into a branded .docx using the company template (preserves logo, fonts, header/footer). Returns a download URL.",
    {
      markdown_content:  z.string().describe("Complete proposal content in markdown format"),
      output_filename:   z.string().default("proposal-final.docx").describe("Output filename, e.g. proposal-final.docx")
    },
    async ({ markdown_content, output_filename }) => {
      const safeName  = basename(output_filename).replace(/[^a-z0-9._-]/gi, "_")
      const tmplFiles = readdirSync(TEMPLATES_DIR).filter(f => extname(f).toLowerCase() === ".docx")
      const tmplPath  = tmplFiles.length > 0 ? join(TEMPLATES_DIR, tmplFiles[0]) : null

      // Parse YAML frontmatter (cover page data) and strip it before pandoc
      const coverData = parseFrontmatter(markdown_content)
      const mdForPandoc = markdown_content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "")

      const mdPath  = join(OUTPUT_DIR, "proposal-draft.md")
      const outPath = join(OUTPUT_DIR, safeName)
      writeFileSync(mdPath, mdForPandoc, "utf-8")

      try { execSync("pandoc --version", { stdio: "pipe" }) } catch {
        return { content: [{ type: "text", text: "pandoc is not installed on this server." }] }
      }

      // Pandoc with --reference-doc copies the template's heading styles, fonts,
      // colors, and paragraph styles into the output DOCX.
      const pandocCmd = tmplPath && existsSync(tmplPath)
        ? `pandoc "${mdPath}" --reference-doc="${tmplPath}" -o "${outPath}"`
        : `pandoc "${mdPath}" -o "${outPath}"`

      try {
        execSync(pandocCmd, { stdio: "pipe" })
      } catch (err) {
        if (tmplPath) {
          try {
            execSync(`pandoc "${mdPath}" -o "${outPath}"`, { stdio: "pipe" })
          } catch (err2) {
            return { content: [{ type: "text", text: `pandoc failed: ${err2.message}` }] }
          }
        } else {
          return { content: [{ type: "text", text: `pandoc failed: ${err.message}` }] }
        }
      }

      // Clone the template, keep cover page + TOC, replace section content
      // with pandoc-generated proposal, substitute cover page placeholders.
      if (tmplPath && existsSync(tmplPath)) {
        try {
          buildProposalFromTemplate(outPath, tmplPath, outPath, coverData)
        } catch (err) {
          console.error("buildProposalFromTemplate error:", err.message)
          try {
            injectTemplateAssets(outPath, tmplPath)
          } catch (err2) {
            console.error("injectTemplateAssets fallback error:", err2.message)
            try {
              const zip = new AdmZip(outPath)
              _applyTableBorders(zip)
              zip.writeZip(outPath)
            } catch {}
          }
        }
      } else {
        try {
          const zip = new AdmZip(outPath)
          _applyTableBorders(zip)
          zip.writeZip(outPath)
        } catch {}
      }

      const downloadUrl   = `${PUBLIC_URL}/download/${safeName}`
      const templateLabel = tmplPath ? tmplPath.split("/").pop() : "none"

      return {
        content: [{
          type: "text",
          text: `Proposal .docx generated.\nTemplate: ${templateLabel}\nDownload: ${downloadUrl}`
        }]
      }
    }
  )

  return server
}

// ── Express app ───────────────────────────────────────────────────────────────

const app    = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id")
  if (req.method === "OPTIONS") return res.sendStatus(204)
  next()
})

// ── OAuth fake handshake ──────────────────────────────────────────────────────

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource:               PUBLIC_URL,
    authorization_servers:  [PUBLIC_URL]
  })
})

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer:                           PUBLIC_URL,
    authorization_endpoint:           `${PUBLIC_URL}/authorize`,
    token_endpoint:                   `${PUBLIC_URL}/token`,
    registration_endpoint:            `${PUBLIC_URL}/register`,
    response_types_supported:         ["code"],
    grant_types_supported:            ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"]
  })
})

app.post("/register", express.json(), express.urlencoded({ extended: false }), (req, res) => {
  const client_id     = randomBytes(16).toString("hex")
  const redirect_uris = (req.body && req.body.redirect_uris) || []
  oauthClients.set(client_id, { redirect_uris })
  res.status(201).json({
    client_id,
    redirect_uris,
    grant_types:                ["authorization_code"],
    response_types:             ["code"],
    token_endpoint_auth_method: "none"
  })
})

// catch JSON parse errors so /register never returns 400
app.use((err, req, res, next) => {
  if (err.status === 400 && err.type === "entity.parse.failed") {
    const client_id = randomBytes(16).toString("hex")
    return res.status(201).json({
      client_id,
      redirect_uris:              [],
      grant_types:                ["authorization_code"],
      response_types:             ["code"],
      token_endpoint_auth_method: "none"
    })
  }
  next(err)
})

app.get("/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query
  const code = randomBytes(32).toString("hex")
  oauthCodes.set(code, { redirect_uri, code_challenge, code_challenge_method, exp: Date.now() + 600_000 })
  const url = new URL(redirect_uri)
  url.searchParams.set("code", code)
  if (state) url.searchParams.set("state", state)
  res.redirect(url.toString())
})

app.post("/token", express.json(), express.urlencoded({ extended: false }), (req, res) => {
  res.json({ access_token: API_KEY, token_type: "Bearer", expires_in: 86400 })
})

// ── MCP endpoint ──────────────────────────────────────────────────────────────

app.all("/mcp", async (req, res) => {
  if (!checkApiKey(req, res)) return

  try {
    const server    = createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    console.error("MCP error:", err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ── Upload: samples ───────────────────────────────────────────────────────────

app.post("/upload/sample", upload.single("file"), (req, res) => {
  if (!checkApiKey(req, res)) return
  if (!req.file) return res.status(400).json({ error: "No file provided" })

  const dest = join(SAMPLES_DIR, req.file.originalname)
  writeFileSync(dest, req.file.buffer)
  console.log(`Sample uploaded: ${req.file.originalname}`)
  res.json({ uploaded: req.file.originalname, size: req.file.size })
})

// ── Upload: template ──────────────────────────────────────────────────────────

app.post("/upload/template", upload.single("file"), (req, res) => {
  if (!checkApiKey(req, res)) return
  if (!req.file) return res.status(400).json({ error: "No file provided" })

  const dest = join(TEMPLATES_DIR, req.file.originalname)
  writeFileSync(dest, req.file.buffer)
  console.log(`Template uploaded: ${req.file.originalname}`)
  res.json({ uploaded: req.file.originalname, size: req.file.size })
})

// ── Download: generated proposals ─────────────────────────────────────────────

app.get("/download/:filename", (req, res) => {
  const safeName = basename(req.params.filename)
  const filePath = join(OUTPUT_DIR, safeName)

  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" })
  }
  res.download(filePath, safeName)
})

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  const samples   = readdirSync(SAMPLES_DIR).filter(f => [".docx",".pdf",".txt"].includes(extname(f))).length
  const templates = readdirSync(TEMPLATES_DIR).filter(f => extname(f) === ".docx").length

  let pandocVersion = "not installed"
  try { pandocVersion = execSync("pandoc --version", { stdio: "pipe" }).toString().split("\n")[0] } catch {}

  res.json({ status: "ok", samples, templates, pandoc: pandocVersion })
})

app.get("/", (req, res) => {
  res.json({ name: "RFP Docs MCP Server", version: "1.0.0", mcp: `${PUBLIC_URL}/mcp` })
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RFP Docs MCP server running on port ${PORT}`)
  console.log(`MCP endpoint: ${PUBLIC_URL}/mcp`)
  console.log(`Health check: ${PUBLIC_URL}/health`)
})
