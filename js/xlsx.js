// A small .xlsx writer: sheets of typed columns, and native Excel charts (column / line) that read their ranges, so the
// workbook opens with live charts in Excel, Numbers and Google Sheets. No library: the zip is written uncompressed
// ("stored"), which every reader accepts. Used by js/features/bookingexport.js.
//
//   buildXlsx([{ name, columns: [{ header, type, width }], rows: [[...]], freeze: true, charts: [chart] }]) -> Blob
//   type: 'text' (default) | 'int' | 'num' | 'money' | 'pct' (a fraction, shown as %) | 'date' ('YYYY-MM-DD' string)
//   chart: { kind: 'column' | 'line', stacked, title, yTitle, from: { sheet, catCol, r0, r1, cols: [col] }, at: { col, row, w, h } }
//     columns and rows are 0-based; r0..r1 are data rows (row 0 is the header, so data starts at 1). Series names are the
//     header cells of their columns. `from.sheet` names the sheet holding the data (default: the chart's own sheet).

const enc = new TextEncoder();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (c) => { let s = ''; c += 1; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const ref = (c, r) => `${colName(c)}${r + 1}`;
const sheetRef = (name) => `'${String(name).replace(/'/g, "''")}'`;

// Style ids in styles.xml cellXfs, below.
const STYLE = { text: 0, header: 1, int: 2, num: 3, money: 4, pct: 5, date: 6 };
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8ECEF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Excel's day serial for a 'YYYY-MM-DD' date (1900 system).
const serial = (d) => { const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); return t / 86400000 + 25569; };

function cellXml(v, type, c, r) {
if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return '';
const at = ref(c, r);
if (type === 'date') {
if (!/^\d{4}-\d{2}-\d{2}/.test(String(v))) return `<c r="${at}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
return `<c r="${at}" s="${STYLE.date}"><v>${serial(String(v))}</v></c>`;
}
if (type === 'int' || type === 'num' || type === 'money' || type === 'pct') {
const n = Number(v);
if (!Number.isFinite(n)) return `<c r="${at}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
return `<c r="${at}" s="${STYLE[type]}"><v>${n}</v></c>`;
}
return `<c r="${at}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml(sh, drawingRid) {
const cols = sh.columns || [];
const nRows = (sh.rows || []).length;
const colsXml = cols.length ? `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || Math.max(9, Math.min(40, String(c.header || '').length + 2))}" customWidth="1"/>`).join('')}</cols>` : '';
const head = cols.length ? `<row r="1">${cols.map((c, i) => `<c r="${ref(i, 0)}" t="inlineStr" s="${STYLE.header}"><is><t xml:space="preserve">${esc(c.header || '')}</t></is></c>`).join('')}</row>` : '';
const body = (sh.rows || []).map((row, ri) => `<row r="${ri + 2}">${row.map((v, ci) => cellXml(v, (cols[ci] || {}).type, ci, ri + 1)).join('')}</row>`).join('');
const freeze = sh.freeze !== false && cols.length ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
const filter = sh.filter !== false && cols.length && nRows ? `<autoFilter ref="A1:${ref(cols.length - 1, nRows)}"/>` : '';
const drawing = drawingRid ? `<drawing r:id="${drawingRid}"/>` : '';
return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${freeze}<sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${head}${body}</sheetData>${filter}${drawing}</worksheet>`;
}

const PALETTE = ['2F6DB5', 'D9822B', '3A9B6A', 'B5485E', '7A5CB0', '8A8F95'];

function chartXml(ch, sheets, ownSheet) {
const f = ch.from;
const src = f.sheet || ownSheet;
const sh = sheets.find((s) => s.name === src);
const S = esc(sheetRef(src));
const catRange = `${S}!$${colName(f.catCol)}$${f.r0 + 1}:$${colName(f.catCol)}$${f.r1 + 1}`;
const line = ch.kind === 'line';
const ser = f.cols.map((c, i) => {
const color = PALETTE[i % PALETTE.length];
const name = `<c:tx><c:strRef><c:f>${S}!$${colName(c)}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc((sh.columns[c] || {}).header || '')}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
const sp = line ? `<c:spPr><a:ln w="22225"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>` : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`;
return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${name}${sp}<c:cat><c:strRef><c:f>${catRange}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${S}!$${colName(c)}$${f.r0 + 1}:$${colName(c)}$${f.r1 + 1}</c:f></c:numRef></c:val>${line ? '<c:smooth val="0"/>' : ''}</c:ser>`;
}).join('');
const title = (t, size = 1300) => `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="${size}" b="1"/></a:pPr><a:r><a:rPr lang="en-GB" sz="${size}" b="1"/><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
const group = line ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="1001"/><c:axId val="1002"/></c:lineChart>`
: `<c:barChart><c:barDir val="col"/><c:grouping val="${ch.stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/>${ch.stacked ? '<c:overlap val="100"/>' : ''}<c:axId val="1001"/><c:axId val="1002"/></c:barChart>`;
const grid = '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E3E6E9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';
const fmt = ch.yFormat ? `<c:numFmt formatCode="${esc(ch.yFormat)}" sourceLinked="0"/>` : '';
return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title(ch.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${group}<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="low"/><c:crossAx val="1002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${grid}${ch.yTitle ? title(ch.yTitle, 1000) : ''}${fmt || '<c:numFmt formatCode="General" sourceLinked="1"/>'}<c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:crossAx val="1001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function drawingXml(charts, firstChartRid) {
const anchors = charts.map((ch, i) => {
const a = ch.at;
return `<xdr:twoCellAnchor><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${a.col + a.w}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row + a.h}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${firstChartRid + i}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}).join('');
return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

// ---- zip (stored) ----
let CRC = null;
function crc32(buf) {
if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
let c = 0xffffffff;
for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
const parts = []; const central = []; let offset = 0;
const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
files.forEach(({ name, data }) => {
const nb = enc.encode(name); const db = typeof data === 'string' ? enc.encode(data) : data;
const crc = crc32(db);
const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(db.length), ...u32(db.length), ...u16(nb.length), ...u16(0)]);
parts.push(local, nb, db);
central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(db.length), ...u32(db.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nb);
offset += local.length + nb.length + db.length;
});
const cdSize = central.reduce((a, b) => a + b.length, 0);
const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function buildXlsx(sheets) {
const files = [];
const ct = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>', '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>', '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
let chartN = 0; let drawingN = 0;
sheets.forEach((sh, i) => {
ct.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
const charts = sh.charts || [];
if (charts.length) {
drawingN++;
files.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingN}.xml"/></Relationships>` });
files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh, 'rId1') });
const rels = charts.map((ch, k) => { chartN++; files.push({ name: `xl/charts/chart${chartN}.xml`, data: chartXml(ch, sheets, sh.name) }); ct.push(`<Override PartName="/xl/charts/chart${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`); return `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartN}.xml"/>`; }).join('');
files.push({ name: `xl/drawings/drawing${drawingN}.xml`, data: drawingXml(charts, 1) });
files.push({ name: `xl/drawings/_rels/drawing${drawingN}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` });
ct.push(`<Override PartName="/xl/drawings/drawing${drawingN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
} else {
files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh, null) });
}
});
files.unshift(
{ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct.join('')}</Types>` },
{ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
{ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${(() => { const dn = sheets.map((sh, i) => (sh.filter !== false && (sh.columns || []).length && (sh.rows || []).length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(sheetRef(sh.name))}!$A$1:$${colName(sh.columns.length - 1)}$${sh.rows.length + 1}</definedName>` : '')).join(''); return dn ? `<definedNames>${dn}</definedNames>` : ''; })()}</workbook>` },
{ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
{ name: 'xl/styles.xml', data: STYLES },
);
return zip(files);
}

export { buildXlsx };
