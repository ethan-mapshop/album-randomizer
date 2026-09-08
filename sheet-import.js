/* Minimal spreadsheet reader — .xlsx and .csv, no dependencies.
 *
 * An .xlsx is a ZIP of XML. Browsers can inflate raw deflate streams natively,
 * so the whole format is reachable with DataView + DOMParser and about two
 * hundred lines, rather than pulling in a megabyte of library.
 *
 * Exposes window.SheetImport = { read(file) -> Promise<{sheets:[{name, rows}]}> }
 */
(function () {
  'use strict';

  var SIG_EOCD = 0x06054b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;

  function decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function inflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* ─────────────────────────── zip ─────────────────────────── */

  function openZip(buffer) {
    var u8 = new Uint8Array(buffer);
    var dv = new DataView(buffer);

    // The end-of-central-directory record sits at the tail, after an optional
    // comment, so scan backwards for its signature.
    var eocd = -1;
    var floor = Math.max(0, u8.length - 65558);
    for (var i = u8.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That does not look like an .xlsx file.');

    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('ZIP64 workbooks are not supported.');

    var files = {};
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== SIG_CENTRAL) break;
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      files[decode(u8.subarray(p + 46, p + 46 + nameLen))] = {
        method: dv.getUint16(p + 10, true),
        size: dv.getUint32(p + 20, true),
        offset: dv.getUint32(p + 42, true)
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { u8: u8, dv: dv, files: files };
  }

  function entry(zip, name) {
    var f = zip.files[name];
    if (!f) return Promise.resolve(null);
    if (zip.dv.getUint32(f.offset, true) !== SIG_LOCAL) {
      return Promise.reject(new Error('Damaged workbook entry: ' + name));
    }
    var nameLen = zip.dv.getUint16(f.offset + 26, true);
    var extraLen = zip.dv.getUint16(f.offset + 28, true);
    var start = f.offset + 30 + nameLen + extraLen;
    var raw = zip.u8.subarray(start, start + f.size);
    if (f.method === 0) return Promise.resolve(raw);
    if (f.method === 8) return inflateRaw(raw);
    return Promise.reject(new Error('Unsupported compression in workbook.'));
  }

  function entryText(zip, name) {
    return entry(zip, name).then(function (b) { return b ? decode(b) : null; });
  }

  /* ─────────────────────────── xlsx ─────────────────────────── */

  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Could not read the workbook XML.');
    return doc;
  }

  // "BC12" -> 54
  function colIndex(ref) {
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function sharedStrings(zip) {
    return entryText(zip, 'xl/sharedStrings.xml').then(function (text) {
      if (!text) return [];
      var out = [];
      var sis = parseXml(text).getElementsByTagName('si');
      for (var i = 0; i < sis.length; i++) {
        // Ignore <rPh> phonetic runs; keep every <t> under the string itself.
        var parts = sis[i].getElementsByTagName('t'), buf = '';
        for (var j = 0; j < parts.length; j++) {
          if (parts[j].parentNode.nodeName === 'rPh') continue;
          buf += parts[j].textContent;
        }
        out.push(buf);
      }
      return out;
    });
  }

  // Maps each sheet's display name to the part that holds it.
  function sheetIndex(zip) {
    return Promise.all([
      entryText(zip, 'xl/workbook.xml'),
      entryText(zip, 'xl/_rels/workbook.xml.rels')
    ]).then(function (both) {
      var wb = both[0], rels = both[1];
      if (!wb) throw new Error('That .xlsx has no workbook inside it.');

      var targets = {};
      if (rels) {
        var rs = parseXml(rels).getElementsByTagName('Relationship');
        for (var i = 0; i < rs.length; i++) {
          var t = rs[i].getAttribute('Target') || '';
          targets[rs[i].getAttribute('Id')] = t.replace(/^\/?(xl\/)?/, 'xl/');
        }
      }

      var out = [];
      var sheets = parseXml(wb).getElementsByTagName('sheet');
      for (var k = 0; k < sheets.length; k++) {
        var rid = sheets[k].getAttribute('r:id') ||
          sheets[k].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        var path = targets[rid] || ('xl/worksheets/sheet' + (k + 1) + '.xml');
        out.push({ name: sheets[k].getAttribute('name') || ('Sheet' + (k + 1)), path: path });
      }
      return out;
    });
  }

  function readSheet(zip, path, shared) {
    return entryText(zip, path).then(function (text) {
      if (!text) return [];
      var rows = [];
      var rowEls = parseXml(text).getElementsByTagName('row');
      for (var i = 0; i < rowEls.length; i++) {
        var cells = [];
        var cs = rowEls[i].getElementsByTagName('c');
        for (var j = 0; j < cs.length; j++) {
          var c = cs[j];
          var at = c.getAttribute('t');
          var value = '';
          if (at === 'inlineStr') {
            var ts = c.getElementsByTagName('t');
            for (var k = 0; k < ts.length; k++) value += ts[k].textContent;
          } else {
            var v = c.getElementsByTagName('v')[0];
            if (v) value = at === 's' ? (shared[+v.textContent] || '') : v.textContent;
          }
          var idx = colIndex(c.getAttribute('r') || '');
          if (idx < 0) idx = j;
          cells[idx] = String(value).trim();
        }
        for (var f = 0; f < cells.length; f++) if (cells[f] === undefined) cells[f] = '';
        rows.push(cells);
      }
      return rows;
    });
  }

  function readXlsx(buffer) {
    var zip = openZip(buffer);
    return sharedStrings(zip).then(function (shared) {
      return sheetIndex(zip).then(function (sheets) {
        return sheets.reduce(function (chain, s) {
          return chain.then(function (acc) {
            return readSheet(zip, s.path, shared).then(function (rows) {
              acc.push({ name: s.name, rows: rows });
              return acc;
            });
          });
        }, Promise.resolve([]));
      });
    }).then(function (sheets) { return { sheets: sheets }; });
  }

  /* ─────────────────────────── csv ─────────────────────────── */

  function readCsv(text) {
    var rows = [], row = [], field = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field.trim()); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field.trim()); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field.length || row.length) { row.push(field.trim()); rows.push(row); }
    return { sheets: [{ name: 'CSV', rows: rows.filter(function (r) { return r.join('').length; }) }] };
  }

  /* ─────────────────────────── entry point ─────────────────────────── */

  function read(file) {
    var isCsv = /\.(csv|tsv|txt)$/i.test(file.name);
    if (isCsv) return file.text().then(readCsv);
    return file.arrayBuffer().then(readXlsx);
  }

  window.SheetImport = { read: read, colIndex: colIndex };
})();
