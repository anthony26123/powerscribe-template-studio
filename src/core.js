/* PowerScribe RTF Template core: parse / edit model / serialize
   Verified offset model: plain-text offsets count \par and \line as 1 char,
   \tab as 1 char, destination groups ({\fonttbl},{\colortbl},{\*\generator}) as 0. */
(function (global) {
  'use strict';

  /* ---------------- tiny XML ---------------- */
  function decodeEnt(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, g) {
      if (g[0] === '#') return String.fromCodePoint(g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[g];
    });
  }
  function encAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function encText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function parseXml(src) {
    var i = 0, n = src.length;
    function skipDecl() {
      while (i < n) {
        if (src.startsWith('<?', i)) { var e = src.indexOf('?>', i); i = e < 0 ? n : e + 2; }
        else if (src.startsWith('<!--', i)) { var e2 = src.indexOf('-->', i); i = e2 < 0 ? n : e2 + 3; }
        else if (/\s/.test(src[i])) i++;
        else break;
      }
    }
    function parseEl() {
      if (src[i] !== '<') throw new Error('XML: expected < at ' + i);
      i++;
      var m = /^[^\s/>]+/.exec(src.slice(i));
      var name = m[0]; i += name.length;
      var attrs = [];
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '/' || src[i] === '>') break;
        var am = /^([^\s=/>]+)\s*=\s*"([^"]*)"/.exec(src.slice(i));
        if (!am) { i++; continue; }
        attrs.push([am[1], decodeEnt(am[2])]); i += am[0].length;
      }
      if (src[i] === '/') { i += 2; return { name: name, attrs: attrs, children: [], selfClose: true }; }
      i++; // '>'
      var children = [], buf = '';
      for (;;) {
        if (i >= n) break;
        if (src[i] === '<') {
          if (src.startsWith('</', i)) {
            if (buf) { children.push({ text: decodeEnt(buf) }); buf = ''; }
            var e = src.indexOf('>', i); i = e + 1; break;
          }
          if (src.startsWith('<!--', i)) { var e3 = src.indexOf('-->', i); i = e3 + 3; continue; }
          if (buf) { children.push({ text: decodeEnt(buf) }); buf = ''; }
          children.push(parseEl());
        } else { buf += src[i]; i++; }
      }
      return { name: name, attrs: attrs, children: children, selfClose: false };
    }
    skipDecl();
    return parseEl();
  }

  function xmlText(node) {
    if (!node) return '';
    var out = '';
    node.children.forEach(function (c) { if (c.text != null) out += c.text; else out += xmlText(c); });
    return out;
  }
  function xmlChild(node, name) {
    for (var k = 0; k < node.children.length; k++) if (node.children[k].name === name) return node.children[k];
    return null;
  }
  function serializeXml(node) {
    if (node.text != null) return encText(node.text);
    var s = '<' + node.name;
    node.attrs.forEach(function (a) { s += ' ' + a[0] + '="' + encAttr(a[1]) + '"'; });
    if (node.selfClose) return s + ' />';
    s += '>';
    node.children.forEach(function (c) { s += serializeXml(c); });
    return s + '</' + node.name + '>';
  }
  function el(name, attrs, children, selfClose) {
    return { name: name, attrs: attrs || [], children: children || [], selfClose: !!selfClose };
  }
  function textEl(name, value) { return el(name, [], [{ text: String(value == null ? '' : value) }]); }

  /* ---------------- RTF split ---------------- */
  function splitRtf(data) {
    var start = data.indexOf('{');
    if (start < 0) throw new Error('Not an RTF file');
    var depth = 0;
    for (var i = start; i < data.length; i++) {
      var c = data[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return { rtf: data.slice(start, i + 1), tail: data.slice(i + 1) }; }
    }
    throw new Error('Unbalanced RTF braces');
  }

  var PARA_WORDS = { pard: 1, nowidctlpar: 1, widctlpar: 1, li: 1, ri: 1, fi: 1, sa: 1, sb: 1, sl: 1, slmult: 1, ql: 1, qc: 1, qr: 1, qj: 1, keep: 1, keepn: 1, intbl: 1, tx: 1, tqc: 1, tqr: 1, tqdec: 1, brdrb: 1, brdrs: 1, brdrw: 1, brsp: 1 };
  var CHAR_TOGGLE = { b: 'b', i: 'i', ul: 'ul', strike: 'strike', caps: 'caps', scaps: 'scaps' };
  var DOC_CHAR = { f: 1, fs: 1, lang: 1, langfe: 1, langnp: 1, kerning: 1, expnd: 1, expndtw: 1, cgrid: 1 };

  /* ---------------- parse ---------------- */
  function parseTemplate(data) {
    var sp = splitRtf(data);
    var rtf = sp.rtf, tail = sp.tail;

    var bodyStart = rtf.indexOf('\\pard');
    if (bodyStart < 0) {
      var lastGrp = rtf.lastIndexOf('}', rtf.length - 2);
      bodyStart = lastGrp < 0 ? 1 : lastGrp + 1;
    }
    var header = rtf.slice(0, bodyStart);
    var body = rtf.slice(bodyStart, rtf.length - 1); // drop final }

    var paras = [], plain = '';
    var cur = { prefix: '', brk: 'par', runs: [] };
    var st = { b: false, i: false, ul: false, strike: false, color: 1 };
    var buf = '', bufStart = 0, pendingRaw = '', charDefaults = '';
    var firstRun = true, ucSkip = 1;

    function flush() {
      if (buf === '') { return; }
      cur.runs.push({ kind: 'text', text: buf, start: bufStart, b: st.b, i: st.i, ul: st.ul, strike: st.strike, color: st.color, raw: pendingRaw });
      pendingRaw = ''; buf = ''; firstRun = false;
    }
    function pushChar(ch) { if (buf === '') bufStart = plain.length; buf += ch; plain += ch; }
    function endPara(brk) {
      flush();
      cur.brk = brk;
      cur.end = plain.length;
      plain += '\n';
      paras.push(cur);
      cur = { prefix: '', brk: 'par', runs: [] };
    }

    var i = 0, n = body.length;
    while (i < n) {
      var c = body[i];
      if (c === '\\') {
        var m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(body.slice(i, i + 40));
        if (m) {
          var w = m[1], p = m[2] != null ? parseInt(m[2], 10) : null, raw = '\\' + w + (m[2] != null ? m[2] : '');
          i += m[0].length;
          if (w === 'par') { endPara('par'); continue; }
          if (w === 'line') { endPara('line'); continue; }
          if (w === 'tab') { pushChar('\t'); continue; }
          if (w === 'cf') { flush(); st.color = p == null ? 0 : p; continue; }
          if (w === 'plain') { flush(); st.b = st.i = st.ul = st.strike = false; continue; }
          if (w === 'ulnone') { flush(); st.ul = false; continue; }
          if (CHAR_TOGGLE[w]) { flush(); st[CHAR_TOGGLE[w]] = (p !== 0); continue; }
          if (w === 'u') {
            pushChar(String.fromCharCode(p < 0 ? p + 65536 : p));
            var skipped = 0;
            while (skipped < ucSkip && i < n) {
              if (body[i] === '\\') { var mm = /^\\(?:'[0-9a-fA-F]{2}|[a-zA-Z]+-?\d*[ ]?)/.exec(body.slice(i, i + 12)); i += mm ? mm[0].length : 2; }
              else i++;
              skipped++;
            }
            continue;
          }
          if (w === 'uc') { ucSkip = p == null ? 1 : p; continue; }
          if (PARA_WORDS[w]) {
            if (cur.runs.length === 0 && buf === '') cur.prefix += raw; else pendingRaw += raw;
            continue;
          }
          if (DOC_CHAR[w] && firstRun && paras.length === 0) { charDefaults += raw; continue; }
          pendingRaw += raw;
          continue;
        }
        var mh = /^\\'([0-9a-fA-F]{2})/.exec(body.slice(i, i + 4));
        if (mh) { pushChar(cp1252ToChar(parseInt(mh[1], 16))); i += 4; continue; }
        if (i + 1 < n) { pushChar(body[i + 1]); i += 2; continue; }
        i++; continue;
      }
      if (c === '{') {
        var d = 0, j = i;
        for (; j < body.length; j++) { if (body[j] === '\\') { j++; continue; } if (body[j] === '{') d++; else if (body[j] === '}') { d--; if (!d) break; } }
        pendingRaw += body.slice(i, j + 1);
        i = j + 1; continue;
      }
      if (c === '}') { i++; continue; }
      if (c === '\r' || c === '\n') { i++; continue; }
      pushChar(c); i++;
    }
    flush();
    if (cur.runs.length || cur.prefix) { cur.end = plain.length; paras.push(cur); }

    /* ---- autotext XML ---- */
    var xmlIdx = tail.indexOf('{\\xml}');
    var xmlRoot = null, tailPrefix = '\r\n {\\xml}', xmlDecl = '<?xml version="1.0" encoding="utf8"?>';
    if (xmlIdx >= 0) {
      tailPrefix = tail.slice(0, xmlIdx + 6);
      var xs = tail.slice(xmlIdx + 6);
      var dm = /^\s*<\?xml[^>]*\?>/.exec(xs);
      if (dm) xmlDecl = dm[0].trim();
      xmlRoot = parseXml(xs);
    }

    var fields = [], uid = 1;
    var fieldsNode = xmlRoot ? xmlChild(xmlRoot, 'fields') : null;
    var extraTop = [];
    if (xmlRoot) {
      xmlRoot.children.forEach(function (c) {
        if (c.name && c.name !== 'fields' && c.name !== 'textSource') extraTop.push(c);
      });
    }
    if (fieldsNode) {
      fieldsNode.children.forEach(function (fn) {
        if (fn.name !== 'field') return;
        var choicesNode = xmlChild(fn, 'choices');
        var synNode = xmlChild(fn, 'synonyms');
        var dv = xmlChild(fn, 'defaultvalue');
        var cp = xmlChild(fn, 'customproperties');
        var props = [];
        if (cp) cp.children.forEach(function (pn) {
          if (pn.name !== 'property') return;
          props.push({ name: xmlText(xmlChild(pn, 'name')), value: xmlText(xmlChild(pn, 'value')) });
        });
        var extras = fn.children.filter(function (c) {
          return c.name && ['name', 'defaultvalue', 'choices', 'synonyms', 'customproperties'].indexOf(c.name) < 0;
        });
        fields.push({
          id: 'f' + (uid++),
          type: parseInt(fn.attrs.reduce(function (a, x) { return x[0] === 'type' ? x[1] : a; }, '1'), 10),
          start: parseInt(fn.attrs.reduce(function (a, x) { return x[0] === 'start' ? x[1] : a; }, '0'), 10),
          length: parseInt(fn.attrs.reduce(function (a, x) { return x[0] === 'length' ? x[1] : a; }, '0'), 10),
          name: xmlText(xmlChild(fn, 'name')),
          defaultValue: dv ? xmlText(dv) : null,
          hasDefault: !!dv,
          choices: choicesNode ? choicesNode.children.filter(function (c) { return c.name === 'choice'; }).map(function (c) {
            return { name: c.attrs.reduce(function (a, x) { return x[0] === 'name' ? x[1] : a; }, ''), value: xmlText(c) };
          }) : null,
          synonyms: synNode ? synNode.children.filter(function (c) { return c.name === 'string'; }).map(xmlText) : null,
          props: props,
          extras: extras
        });
      });
    }

    /* ---- map fields onto runs ---- */
    var byStart = fields.slice().sort(function (a, b) { return a.start - b.start; });
    byStart.forEach(function (f) {
      var s = f.start, e = f.start + f.length;
      for (var pi = 0; pi < paras.length; pi++) {
        var P = paras[pi], runs = P.runs, hit = [];
        for (var ri = 0; ri < runs.length; ri++) {
          var r = runs[ri];
          if (r.kind !== 'text') continue;
          var rs = r.start, re = r.start + r.text.length;
          if (re <= s || rs >= e) continue;
          hit.push(ri);
        }
        if (!hit.length) continue;
        var first = hit[0], last = hit[hit.length - 1];
        var head = null, tailR = null;
        var rf = runs[first];
        if (rf.start < s) head = { kind: 'text', text: rf.text.slice(0, s - rf.start), start: rf.start, b: rf.b, i: rf.i, ul: rf.ul, strike: rf.strike, color: rf.color, raw: rf.raw };
        var rl = runs[last];
        if (rl.start + rl.text.length > e) tailR = { kind: 'text', text: rl.text.slice(e - rl.start), start: e, b: rl.b, i: rl.i, ul: rl.ul, strike: rl.strike, color: 1, raw: '' };
        var repl = [];
        if (head) repl.push(head);
        repl.push({ kind: 'field', fieldId: f.id, start: s });
        if (tailR) repl.push(tailR);
        runs.splice(first, last - first + 1, ...repl);
        f.located = true;
        break;
      }
    });

    var doc = {
      header: header,
      charDefaults: charDefaults,
      paragraphs: paras,
      fields: fields,
      fieldMap: fields.reduce(function (m, f) { m[f.id] = f; return m; }, {}),
      xmlDecl: xmlDecl,
      xmlAttrs: xmlRoot ? xmlRoot.attrs : [['version', '2'], ['editMode', '2']],
      xmlExtraTop: extraTop,
      tailPrefix: tailPrefix,
      plain: plain,
      original: data,
      nextId: uid
    };
    return doc;
  }

  /* ---------------- helpers ---------------- */
  function displayToken(choice) {
    var t = (choice.name && choice.name.trim()) ? choice.name : (choice.value || '');
    return String(t).trim();
  }
  function fieldBodyText(f) {
    if (f.type !== 3 || !f.choices || !f.choices.length) return f.name;
    return f.name + ':' + f.choices.map(displayToken).join('/');
  }
  function prop(f, name) {
    for (var k = 0; k < f.props.length; k++) if (f.props[k].name === name) return f.props[k].value;
    return null;
  }
  function setProp(f, name, value) {
    for (var k = 0; k < f.props.length; k++) if (f.props[k].name === name) { f.props[k].value = value; return; }
    f.props.push({ name: name, value: value });
  }
  var DEFAULT_PROPS = ['AllCaps', 'AllowEmpty', 'ImpressionField', 'DoesNotIndicateFindings', 'FindingsCodes', 'EnforcePickList'];
  function newField(doc, type, name) {
    var f = {
      id: 'f' + (doc.nextId++), type: type || 3, name: name || 'NewField',
      defaultValue: null, hasDefault: false,
      choices: type === 3 ? [{ name: 'normal', value: 'Normal.' }] : null,
      synonyms: null,
      props: DEFAULT_PROPS.map(function (p) { return { name: p, value: p === 'FindingsCodes' ? '' : 'False' }; }),
      extras: []
    };
    doc.fields.push(f); doc.fieldMap[f.id] = f;
    return f;
  }

  /* ---------------- serialize ---------------- */
  function cp1252ToChar(b) {
    var map = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' };
    return map[b] || String.fromCharCode(b);
  }
  var CP1252_REV = (function () {
    var m = {};
    for (var b = 128; b < 256; b++) m[cp1252ToChar(b)] = b;
    return m;
  })();

  function escapeRtf(s) {
    var out = '';
    for (var k = 0; k < s.length; k++) {
      var ch = s[k], code = s.charCodeAt(k);
      if (ch === '\\') out += '\\\\';
      else if (ch === '{') out += '\\{';
      else if (ch === '}') out += '\\}';
      else if (ch === '\t') out += '\\tab ';
      else if (code < 128) out += ch;
      else if (CP1252_REV[ch] != null) out += "\\'" + CP1252_REV[ch].toString(16);
      else out += '\\u' + code + '?';
    }
    return out;
  }

  function serializeTemplate(doc) {
    var out = doc.header;
    var plain = '';
    var ranges = [];
    var st = { b: false, i: false, ul: false, strike: false, color: null };
    var pendingCtrl = false;
    var usedFields = [];

    function ctrl(s) { out += s; pendingCtrl = true; }
    function emitText(t) {
      if (t === '') return;
      if (pendingCtrl) { out += ' '; pendingCtrl = false; }
      out += escapeRtf(t);
      plain += t;
    }
    function setColor(c) { if (st.color !== c) { st.color = c; ctrl('\\cf' + c); } }
    function setFmt(r) {
      if (!!r.b !== st.b) { st.b = !!r.b; ctrl(st.b ? '\\b' : '\\b0'); }
      if (!!r.i !== st.i) { st.i = !!r.i; ctrl(st.i ? '\\i' : '\\i0'); }
      if (!!r.ul !== st.ul) { st.ul = !!r.ul; ctrl(st.ul ? '\\ul' : '\\ulnone'); }
      if (!!r.strike !== st.strike) { st.strike = !!r.strike; ctrl(st.strike ? '\\strike' : '\\strike0'); }
    }

    doc.paragraphs.forEach(function (P, pi) {
      if (P.prefix) ctrl(P.prefix);
      if (pi === 0 && doc.charDefaults) { setColor(1); ctrl(doc.charDefaults); }
      P.runs.forEach(function (r) {
        if (r.kind === 'text') {
          setFmt(r);
          setColor(r.color == null ? 1 : r.color);
          if (r.raw) ctrl(r.raw);
          emitText(r.text);
        } else {
          var f = doc.fieldMap[r.fieldId];
          if (!f) return;
          usedFields.push(f);
          var fStart = plain.length;
          setColor(2);
          var nameStart = plain.length;
          emitText(f.name);
          var nameRange = { type: f.type, start: nameStart, length: f.name.length };
          var defRange = null;
          if (f.type === 3 && f.choices && f.choices.length) {
            setColor(1); emitText(':');
            f.choices.forEach(function (ch, ci) {
              if (ci > 0) { setColor(1); emitText('/'); }
              var tok = displayToken(ch);
              var isDef = f.hasDefault && f.defaultValue != null && tok === String(f.defaultValue).trim() && !defRange;
              setColor(isDef ? 2 : 1);
              var ts = plain.length;
              emitText(tok);
              if (isDef) defRange = { type: 3, start: ts, length: tok.length };
            });
          }
          f._start = fStart; f._length = plain.length - fStart;
          ranges.push(nameRange);
          if (defRange) ranges.push(defRange);
        }
      });
      if (st.color !== 1) { st.color = 1; ctrl('\\cf1'); }
      out += (P.brk === 'line' ? '\\line' : '\\par') + '\r\n';
      plain += '\n';
      pendingCtrl = false;
    });
    out += '}';

    /* ---- rebuild XML ---- */
    var fieldEls = usedFields.map(function (f) {
      var kids = [textEl('name', f.name)];
      if (f.hasDefault && f.defaultValue != null) kids.push(textEl('defaultvalue', f.defaultValue));
      if (f.type === 3 && f.choices) {
        kids.push(el('choices', [], f.choices.map(function (c) {
          return el('choice', [['name', c.name || '']], [{ text: c.value == null ? '' : c.value }]);
        })));
      }
      if (f.synonyms && f.synonyms.length) {
        kids.push(el('synonyms', [], f.synonyms.map(function (s) { return textEl('string', s); })));
      }
      (f.extras || []).forEach(function (x) { kids.push(x); });
      kids.push(el('customproperties', [], f.props.map(function (p) {
        return el('property', [], [textEl('name', p.name), textEl('value', p.value == null ? '' : p.value)]);
      })));
      return el('field', [['type', String(f.type)], ['start', String(f._start)], ['length', String(f._length)]], kids);
    });

    var rangeEls = ranges.slice().sort(function (a, b) { return a.start - b.start; }).map(function (r) {
      return el('range', [['type', String(r.type)], ['start', String(r.start)], ['length', String(r.length)]], [], true);
    });

    var rootKids = [el('fields', [], fieldEls)];
    var sawLinks = false;
    (doc.xmlExtraTop || []).forEach(function (x) { rootKids.push(x); if (x.name === 'links') sawLinks = true; });
    if (!sawLinks) rootKids.push(el('links', [], [], true));
    rootKids.push(el('textSource', [], rangeEls));
    var root = el('autotext', doc.xmlAttrs, rootKids);

    return out + doc.tailPrefix + doc.xmlDecl + serializeXml(root);
  }

  /* ---------------- validation ---------------- */
  function validate(doc) {
    var issues = [];
    var seen = {};
    var used = {};
    doc.paragraphs.forEach(function (P) { P.runs.forEach(function (r) { if (r.kind === 'field') used[r.fieldId] = true; }); });
    doc.fields.forEach(function (f) {
      if (!used[f.id]) { issues.push({ level: 'warn', field: f.id, msg: 'Field "' + f.name + '" is defined but not placed in the report body (it will be dropped on save).' }); return; }
      if (!f.name || !f.name.trim()) issues.push({ level: 'error', field: f.id, msg: 'A field has an empty name.' });
      var key = f.name.toLowerCase();
      if (seen[key]) issues.push({ level: 'warn', field: f.id, msg: 'Duplicate field name "' + f.name + '" — PowerScribe matches fields by name.' });
      seen[key] = true;
      if (/[:/]/.test(f.name)) issues.push({ level: 'error', field: f.id, msg: 'Field name "' + f.name + '" contains ":" or "/", which breaks the template syntax.' });
      if (f.type === 3) {
        if (!f.choices || !f.choices.length) issues.push({ level: 'error', field: f.id, msg: 'Pick list "' + f.name + '" has no choices.' });
        var toks = {};
        (f.choices || []).forEach(function (c) {
          var t = displayToken(c);
          if (!t) issues.push({ level: 'error', field: f.id, msg: 'Pick list "' + f.name + '" has a choice with no label and no text.' });
          if (/[:/]/.test(t)) issues.push({ level: 'error', field: f.id, msg: 'Choice label "' + t + '" in "' + f.name + '" contains ":" or "/", which breaks the template syntax.' });
          if (toks[t]) issues.push({ level: 'warn', field: f.id, msg: 'Pick list "' + f.name + '" has two choices labelled "' + t + '".' });
          toks[t] = 1;
        });
        if (f.hasDefault && f.defaultValue != null && !toks[String(f.defaultValue).trim()]) {
          issues.push({ level: 'error', field: f.id, msg: 'Default "' + f.defaultValue + '" of "' + f.name + '" does not match any choice.' });
        }
      }
    });
    return issues;
  }

  /* round-trip self check: reparse output, compare field text at recorded offsets */
  function selfCheck(text) {
    var d = parseTemplate(text);
    var bad = [];
    d.fields.forEach(function (f) {
      var seg = d.plain.substr(f.start, f.length);
      var expect = fieldBodyText(f);
      if (seg !== expect) bad.push({ name: f.name, got: seg, expect: expect });
    });
    return bad;
  }

  var API = {
    parseTemplate: parseTemplate, serializeTemplate: serializeTemplate,
    displayToken: displayToken, fieldBodyText: fieldBodyText,
    prop: prop, setProp: setProp, newField: newField, validate: validate,
    selfCheck: selfCheck, DEFAULT_PROPS: DEFAULT_PROPS, escapeRtf: escapeRtf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.PSCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
