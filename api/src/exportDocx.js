// Generic "download as Word" endpoint. Takes the markdown the client already
// builds (research dossier, battlecard, …) and returns a real .docx — replacing
// the old raw .md downloads. Mounted authed at /api/export.

const express = require('express');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

// Inline markdown → docx TextRuns. Supports **bold**; everything else is plain.
function parseInline(text) {
  const runs = [];
  for (const p of String(text).split(/(\*\*[^*]+\*\*)/g)) {
    if (!p) continue;
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    runs.push(m ? new TextRun({ text: m[1], bold: true }) : new TextRun(p));
  }
  return runs.length ? runs : [new TextRun(String(text))];
}

// Line-based markdown → docx paragraphs. Handles #/##/### headings, - / * bullets,
// **bold**, and plain paragraphs (the shapes our downloads produce).
function mdToParagraphs(markdown) {
  const out = [];
  for (const raw of String(markdown || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('### ')) { out.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 })); continue; }
    if (line.startsWith('## '))  { out.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 })); continue; }
    if (line.startsWith('# '))   { out.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 })); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { out.push(new Paragraph({ children: parseInline(bullet[1]), bullet: { level: 0 } })); continue; }
    out.push(new Paragraph({ children: parseInline(line), spacing: { after: 120 } }));
  }
  if (!out.length) out.push(new Paragraph({ text: '' }));
  return out;
}

async function markdownToDocxBuffer(markdown) {
  const doc = new Document({ sections: [{ children: mdToParagraphs(markdown) }] });
  return Packer.toBuffer(doc);
}

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

// POST /api/export/docx  { filename, markdown } → .docx attachment
router.post('/docx', async (req, res) => {
  const md = String((req.body && req.body.markdown) || '');
  let fn = String((req.body && req.body.filename) || 'document.docx').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!/\.docx$/i.test(fn)) fn += '.docx';
  if (!md.trim()) return res.status(400).json({ error: 'markdown required' });
  try {
    const buf = await markdownToDocxBuffer(md);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${fn}"`);
    res.send(buf);
  } catch (err) {
    console.error('[export] docx failed:', (err && err.message) || err);
    res.status(500).json({ error: 'Could not generate the Word document.' });
  }
});

module.exports = { router, markdownToDocxBuffer };
