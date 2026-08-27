(function () {
'use strict';
var C = window.PSCore;
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var TYPE = { 1: 'Text field', 2: 'Fill-in field', 3: 'Pick list' };
var TYPE_HINT = {
  1: 'A stop the radiologist dictates into. May carry default text.',
  2: 'A stop with no stored default text (e.g. Images, DLP).',
  3: 'A pick list: one of several canned statements.'
};
var PROP_HINT = {
  AllCaps: 'Force the dictated text to upper case.',
  AllowEmpty: 'The field may be left blank in the finished report.',
  ImpressionField: 'Marks this field as the report impression.',
  DoesNotIndicateFindings: 'Text here is not treated as a finding for coding.',
  FindingsCodes: 'Findings codes attached to this field.',
  EnforcePickList: 'Only the listed choices may be used — no free text.'
};

var S = { tpls: [], active: -1, sel: null, mode: 'edit', showLists: false, clip: null, filter: '', issues: [] };
function cur() { return S.tpls[S.active] || null; }
function doc() { return cur() ? cur().doc : null; }

/* ---------- undo ---------- */
function snap(d) {
  var o = {};
  for (var k in d) if (['fieldMap', 'plain', 'original'].indexOf(k) < 0) o[k] = d[k];
  return JSON.stringify(o);
}
function pushUndo() {
  var t = cur(); if (!t) return;
  syncFromDom();
  t.undo.push(snap(t.doc)); if (t.undo.length > 80) t.undo.shift();
  t.redo.length = 0; t.dirty = true;
}
function applySnap(t, json) {
  var o = JSON.parse(json);
  o.fieldMap = {}; o.fields.forEach(function (f) { o.fieldMap[f.id] = f; });
  o.original = t.doc.original;
  t.doc = o;
}
function undo() {
  var t = cur(); if (!t || !t.undo.length) return;
  syncFromDom(); t.redo.push(snap(t.doc));
  applySnap(t, t.undo.pop()); t.dirty = true; renderAll();
}
function redo() {
  var t = cur(); if (!t || !t.redo.length) return;
  t.undo.push(snap(t.doc)); applySnap(t, t.redo.pop()); t.dirty = true; renderAll();
}

/* ---------- files ---------- */
function openFiles(list) {
  var files = Array.prototype.slice.call(list);
  var pending = files.length, base = S.tpls.length;
  files.forEach(function (file, fi) {
    var seq = base + fi;
    var fr = new FileReader();
    fr.onload = function () {
      var text;
      try { text = new TextDecoder('windows-1252').decode(new Uint8Array(fr.result)); }
      catch (e) {
        var u = new Uint8Array(fr.result), s = '';
        for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
        text = s;
      }
      try {
        var d = C.parseTemplate(text);
        S.tpls.push({ name: file.name, doc: d, dirty: false, undo: [], redo: [], pv: {}, pvText: {}, seq: seq });
        S.tpls.sort(function (a, b) { return a.seq - b.seq; });
        S.active = S.tpls.length - 1; S.sel = null;
      } catch (e) {
        alert('Could not read "' + file.name + '":\n' + e.message);
      }
      if (--pending === 0) renderAll();
    };
    fr.readAsArrayBuffer(file);
  });
}
function download(name, text) {
  var b = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); b[i] = c < 256 ? c : 63; }
  var url = URL.createObjectURL(new Blob([b], { type: 'application/rtf' }));
  var a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
}
function save() {
  var t = cur(); if (!t) return;
  syncFromDom();
  var iss = C.validate(t.doc).filter(function (i) { return i.level === 'error'; });
  if (iss.length && !confirm(iss.length + ' problem(s) would produce a broken template:\n\n' +
      iss.slice(0, 6).map(function (i) { return '• ' + i.msg; }).join('\n') + '\n\nSave anyway?')) return;
  var out = C.serializeTemplate(t.doc);
  var bad = C.selfCheck(out);
  if (bad.length) { alert('Internal check failed — field offsets do not line up. Nothing was saved.\n' + JSON.stringify(bad[0])); return; }
  download(t.name, out);
  t.dirty = false; renderTabs(); renderStatus();
}

/* ---------- render: shell ---------- */
function renderAll() { renderTabs(); renderOutline(); renderCenter(); renderInspector(); renderStatus(); }

function renderTabs() {
  var el = $('#tabs'); el.innerHTML = '';
  S.tpls.forEach(function (t, i) {
    var d = document.createElement('div');
    d.className = 'tab' + (i === S.active ? ' on' : '');
    d.innerHTML = (t.dirty ? '<span class="dot"></span>' : '') +
      '<span>' + esc(t.name.replace(/\.rtf$/i, '')) + '</span><span class="x">×</span>';
    d.onclick = function (e) {
      if (e.target.classList.contains('x')) {
        if (t.dirty && !confirm('"' + t.name + '" has unsaved changes. Close anyway?')) return;
        S.tpls.splice(i, 1); S.active = Math.min(S.active, S.tpls.length - 1); S.sel = null;
      } else { S.active = i; S.sel = null; }
      renderAll();
    };
    el.appendChild(d);
  });
}

function renderStatus() {
  var t = cur();
  if (!t) { $('#stat').textContent = 'No template open'; $('#vsum').innerHTML = ''; return; }
  var d = t.doc, pk = d.fields.filter(function (f) { return f.type === 3; }).length;
  var ch = d.fields.reduce(function (a, f) { return a + (f.choices ? f.choices.length : 0); }, 0);
  $('#stat').textContent = d.fields.length + ' fields · ' + pk + ' pick lists · ' + ch + ' choices · ' +
    d.paragraphs.length + ' paragraphs' + (t.dirty ? ' · unsaved changes' : '');
  S.issues = C.validate(d);
  var er = S.issues.filter(function (i) { return i.level === 'error'; }).length;
  var wr = S.issues.length - er;
  var v = $('#vsum'); v.innerHTML = '';
  var b = document.createElement('button'); b.className = 'ghost small';
  b.innerHTML = er ? '<span style="color:var(--err)">● ' + er + ' error' + (er > 1 ? 's' : '') + '</span>' +
      (wr ? ' <span style="color:var(--warn)">● ' + wr + '</span>' : '')
    : (wr ? '<span style="color:var(--warn)">● ' + wr + ' warning' + (wr > 1 ? 's' : '') + '</span>'
          : '<span style="color:var(--ok)">● valid</span>');
  b.onclick = toggleIssues; v.appendChild(b);
}
function toggleIssues() {
  var old = $('.issues'); if (old) { old.remove(); return; }
  if (!S.issues.length) return;
  var box = document.createElement('div'); box.className = 'issues';
  S.issues.forEach(function (i) {
    var r = document.createElement('div'); r.className = 'iss ' + i.level;
    r.innerHTML = '<span class="k">' + i.level + '</span><span>' + esc(i.msg) + '</span>';
    r.onclick = function () { if (i.field) { S.sel = i.field; renderOutline(); renderInspector(); scrollToField(i.field); } box.remove(); };
    box.appendChild(r);
  });
  document.body.appendChild(box);
}

function renderOutline() {
  var el = $('#outline'); el.innerHTML = '';
  var t = cur(); if (!t) return;
  var d = t.doc, q = S.filter.toLowerCase();
  var used = {};
  d.paragraphs.forEach(function (P) { P.runs.forEach(function (r) { if (r.kind === 'field') used[r.fieldId] = 1; }); });
  var order = [];
  d.paragraphs.forEach(function (P) { P.runs.forEach(function (r) { if (r.kind === 'field' && d.fieldMap[r.fieldId]) order.push(d.fieldMap[r.fieldId]); }); });
  d.fields.forEach(function (f) { if (!used[f.id]) order.push(f); });
  order.forEach(function (f) {
    if (q) {
      var hay = f.name + ' ' + (f.choices || []).map(function (c) { return c.name + ' ' + c.value; }).join(' ') + ' ' + (f.defaultValue || '');
      if (hay.toLowerCase().indexOf(q) < 0) return;
    }
    var r = document.createElement('div');
    r.className = 'oitem' + (S.sel === f.id ? ' on' : '');
    var badges = '<span class="badge' + (f.type === 3 ? ' t3' : '') + '">' + (f.type === 3 ? (f.choices || []).length + ' ch' : 'T' + f.type) + '</span>';
    if (C.prop(f, 'ImpressionField') === 'True') badges += '<span class="badge imp">imp</span>';
    if (!used[f.id]) badges += '<span class="badge" style="color:var(--warn);border-color:var(--warn)">unplaced</span>';
    r.innerHTML = '<span class="nm">' + esc(f.name) + '</span>' + badges;
    r.onclick = function () { S.sel = f.id; renderOutline(); renderInspector(); scrollToField(f.id); };
    el.appendChild(r);
  });
  if (!el.children.length) el.innerHTML = '<div class="empty small">No matching fields</div>';
}
function scrollToField(id) {
  var c = $('.chip[data-fid="' + id + '"]');
  if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- center ---------- */
function renderCenter() {
  var w = $('#docwrap'); w.innerHTML = ''; $('#toolbar').innerHTML = ''; w.scrollTop = 0;
  var t = cur();
  if (!t) { w.appendChild(welcome()); return; }
  if (S.mode === 'edit') w.appendChild(renderEdit(t));
  else if (S.mode === 'preview') w.appendChild(renderPreview(t));
  else w.appendChild(renderSource(t));
}
function welcome() {
  var d = document.createElement('div'); d.className = 'welcome';
  d.innerHTML = '<h1>PowerScribe Template Studio</h1>' +
    '<p>Open a PowerScribe AutoText <b>.rtf</b> template to view and edit it — everything stays on this computer.</p>' +
    '<div class="card"><h3>What it does</h3><ul>' +
    '<li>Reads the report body <i>and</i> the embedded AutoText field definitions.</li>' +
    '<li>Edit pick lists: add, reorder, relabel, retext, and set the default choice.</li>' +
    '<li>Edit field properties, field names, types, synonyms and the report prose.</li>' +
    '<li>Preview the finished report with any combination of choices.</li>' +
    '<li>Saves a valid .rtf with every field offset recomputed for PowerScribe.</li>' +
    '</ul></div>' +
    '<p style="margin-top:18px"><button class="primary" id="w-open">Open template…</button> ' +
    '<span class="small">or drop files anywhere</span></p>';
  setTimeout(function () { var b = $('#w-open'); if (b) b.onclick = function () { $('#file').click(); }; }, 0);
  return d;
}

/* ---------- edit view ---------- */
function renderEdit(t) {
  var host = document.createElement('div');
  var bar = document.createElement('div');
  bar.className = 'row'; bar.style.cssText = 'max-width:820px;margin:0 auto;gap:6px';
  bar.innerHTML =
    '<button class="icon" data-cmd="bold" title="Bold"><b>B</b></button>' +
    '<button class="icon" data-cmd="italic" title="Italic"><i>I</i></button>' +
    '<button class="icon" data-cmd="underline" title="Underline"><u>U</u></button>' +
    '<span style="width:8px"></span>' +
    '<button id="insField">Insert field at cursor</button>' +
    '<span class="sp"></span>' +
    '<button class="ghost small" id="undoBtn" title="Undo model change">↶ Undo</button>' +
    '<button class="ghost small" id="redoBtn">↷ Redo</button>';
  $('#toolbar').appendChild(bar);
  $$('button[data-cmd]', bar).forEach(function (b) {
    b.onmousedown = function (e) { e.preventDefault(); };
    b.onclick = function () { document.execCommand(b.dataset.cmd, false, null); onInput(); };
  });
  $('#undoBtn', bar) && ($('#undoBtn', bar).onclick = undo);
  $('#redoBtn', bar) && ($('#redoBtn', bar).onclick = redo);
  $('#insField', bar).onclick = insertFieldAtCaret;

  var sheet = document.createElement('div'); sheet.className = 'sheet';
  var body = document.createElement('div');
  body.id = 'body'; body.contentEditable = 'true'; body.spellcheck = false;
  try { document.execCommand('styleWithCSS', false, false); } catch (e) {}
  t.doc.paragraphs.forEach(function (P) { body.appendChild(renderPara(P, t.doc)); });
  body.addEventListener('input', onInput);
  body.addEventListener('keydown', onKeydown);
  body.addEventListener('paste', onPaste);
  body.addEventListener('click', function (e) {
    var chip = e.target.closest ? e.target.closest('.chip') : null;
    if (chip) { S.sel = chip.dataset.fid; renderOutline(); renderInspector(); markChips(); }
  });
  sheet.appendChild(body); host.appendChild(sheet);
  setTimeout(markChips, 0);
  return host;
}
function renderPara(P, d) {
  var p = document.createElement('div'); p.className = 'para';
  p.dataset.prefix = P.prefix || ''; p.dataset.brk = P.brk || 'par';
  P.runs.forEach(function (r) {
    if (r.kind === 'field') { var f = d.fieldMap[r.fieldId]; if (f) p.appendChild(chipEl(f)); return; }
    p.appendChild(textEl(r));
  });
  if (!p.childNodes.length) p.appendChild(document.createElement('br'));
  return p;
}
function textEl(r) {
  var node = document.createTextNode(r.text);
  function wrap(tag) { var e = document.createElement(tag); e.appendChild(node); node = e; }
  if (r.strike) wrap('s');
  if (r.ul) wrap('u');
  if (r.i) wrap('i');
  if (r.b) wrap('b');
  if ((r.color != null && r.color !== 1) || r.raw) {
    var s = document.createElement('span'); s.className = 'run';
    if (r.color != null && r.color !== 1) s.dataset.color = r.color;
    if (r.raw) s.dataset.raw = r.raw;
    s.appendChild(node); node = s;
  }
  return node;
}
function chipEl(f) {
  var s = document.createElement('span');
  s.className = 'chip'; s.contentEditable = 'false'; s.dataset.fid = f.id;
  s.title = TYPE[f.type] + (f.defaultValue ? ' · default: ' + f.defaultValue : '');
  var h = '<span class="n">' + esc(f.name) + '</span>';
  if (f.type === 3 && f.choices && f.choices.length) {
    h += '<span class="sep">:</span>';
    if (S.showLists) {
      h += f.choices.map(function (c) {
        var tok = C.displayToken(c);
        var isDef = f.hasDefault && String(f.defaultValue).trim() === tok;
        return '<span class="' + (isDef ? 'def' : 'alt') + '" title="' + esc(c.value || '') + '">' + esc(tok) + '</span>';
      }).join('<span class="alt">/</span>');
    } else {
      var dt = f.hasDefault ? String(f.defaultValue) : C.displayToken(f.choices[0]);
      h += '<span class="' + (f.hasDefault ? 'def' : 'alt') + '">' + esc(dt) + '</span>' +
           '<span class="cnt">' + f.choices.length + '</span>';
    }
  } else if (f.defaultValue) {
    h += '<span class="cnt" title="' + esc(f.defaultValue) + '">text</span>';
  }
  s.innerHTML = h;
  return s;
}
function markChips() {
  $$('.chip').forEach(function (c) { c.classList.toggle('on', c.dataset.fid === S.sel); });
}
function refreshChips(fid) {
  var t = cur(); if (!t) return;
  if (S.mode !== 'edit') { renderCenter(); return; }
  var f = t.doc.fieldMap[fid]; if (!f) return;
  $$('.chip[data-fid="' + fid + '"]').forEach(function (old) {
    var n = chipEl(f); n.classList.toggle('on', fid === S.sel);
    old.parentNode.replaceChild(n, old);
  });
}

var syncTimer = null;
function onInput() {
  var t = cur(); if (!t) return;
  t.dirty = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { syncFromDom(); renderStatus(); renderTabs(); renderOutline(); }, 350);
}
function onPaste(e) {
  e.preventDefault();
  var txt = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, txt);
}
function onKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    var sel = window.getSelection(); if (!sel.rangeCount) return;
    var r = sel.getRangeAt(0); r.deleteContents();
    var para = closestPara(r.startContainer); if (!para) return;
    var after = document.createRange();
    after.setStart(r.startContainer, r.startOffset);
    after.setEndAfter(para.lastChild || para);
    var frag = after.extractContents();
    var np = document.createElement('div'); np.className = 'para';
    np.dataset.prefix = para.dataset.prefix || ''; np.dataset.brk = para.dataset.brk || 'par';
    np.appendChild(frag);
    if (!np.childNodes.length || !np.textContent && !np.querySelector('.chip')) { np.innerHTML = ''; np.appendChild(document.createElement('br')); }
    if (!para.childNodes.length || (!para.textContent && !para.querySelector('.chip'))) { para.innerHTML = ''; para.appendChild(document.createElement('br')); }
    para.parentNode.insertBefore(np, para.nextSibling);
    var nr = document.createRange(); nr.setStart(np, 0); nr.collapse(true);
    sel.removeAllRanges(); sel.addRange(nr);
    onInput(); return;
  }
  if (e.key === 'Backspace') {
    var s2 = window.getSelection();
    if (s2.isCollapsed) {
      var p2 = closestPara(s2.anchorNode);
      if (p2 && atStart(p2, s2) && p2.previousElementSibling) {
        e.preventDefault();
        var prev = p2.previousElementSibling;
        if (prev.lastChild && prev.lastChild.nodeName === 'BR') prev.removeChild(prev.lastChild);
        var mark = document.createTextNode('');
        prev.appendChild(mark);
        while (p2.firstChild) { if (p2.firstChild.nodeName === 'BR') { p2.removeChild(p2.firstChild); continue; } prev.appendChild(p2.firstChild); }
        p2.remove();
        var r3 = document.createRange(); r3.setStart(mark, 0); r3.collapse(true);
        s2.removeAllRanges(); s2.addRange(r3);
        onInput(); return;
      }
    }
  }
}
function closestPara(node) {
  while (node && node !== document) {
    if (node.nodeType === 1 && node.classList.contains('para')) return node;
    node = node.parentNode;
  }
  return null;
}
function atStart(para, sel) {
  var r = document.createRange(); r.selectNodeContents(para);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length === 0;
}
function insertFieldAtCaret() {
  var t = cur(); if (!t) return;
  if (S.mode !== 'edit') {
    S.mode = 'edit';
    $$('#modeseg button').forEach(function (x) { x.classList.toggle('on', x.dataset.mode === 'edit'); });
    renderCenter();
  }
  pushUndo();
  var f = C.newField(t.doc, 3, 'NewField');
  f.choices = [{ name: 'normal', value: 'Normal.' }, { name: 'abnormal', value: 'Abnormal.' }];
  f.hasDefault = true; f.defaultValue = 'normal';
  var chip = chipEl(f);
  var sel = window.getSelection();
  var body = $('#body');
  if (sel.rangeCount && body && body.contains(sel.anchorNode)) {
    var r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(chip);
    var sp = document.createTextNode(' '); chip.parentNode.insertBefore(sp, chip.nextSibling);
    var nr = document.createRange(); nr.setStartAfter(sp); nr.collapse(true);
    sel.removeAllRanges(); sel.addRange(nr);
  } else if (body) {
    var p = body.lastElementChild || body;
    p.appendChild(document.createTextNode(' ')); p.appendChild(chip);
  }
  S.sel = f.id;
  syncFromDom(); renderOutline(); renderInspector(); renderStatus(); markChips();
}

/* ---------- DOM -> model ---------- */
function syncFromDom() {
  var t = cur(); if (!t || S.mode !== 'edit') return;
  var body = $('#body'); if (!body) return;
  var paras = [];
  $$('.para', body).forEach(function (p) {
    paras.push({ prefix: p.dataset.prefix || '', brk: p.dataset.brk || 'par', runs: deriveRuns(p) });
  });
  if (!paras.length) paras.push({ prefix: '', brk: 'par', runs: [] });
  t.doc.paragraphs = paras;
}
function deriveRuns(root) {
  var runs = [], pendRaw = '';
  function push(r) {
    var last = runs[runs.length - 1];
    if (last && last.kind === 'text' && !r.raw && !last._sealed &&
        last.b === r.b && last.i === r.i && last.ul === r.ul && last.strike === r.strike && last.color === r.color) {
      last.text += r.text; return;
    }
    runs.push(r);
  }
  (function walk(node, fmt) {
    for (var k = 0; k < node.childNodes.length; k++) {
      var ch = node.childNodes[k];
      if (ch.nodeType === 3) {
        if (!ch.nodeValue) continue;
        var raw = pendRaw; pendRaw = '';
        push({ kind: 'text', text: ch.nodeValue, b: fmt.b, i: fmt.i, ul: fmt.ul, strike: fmt.strike, color: fmt.color, raw: raw });
        continue;
      }
      if (ch.nodeType !== 1) continue;
      if (ch.classList && ch.classList.contains('chip')) { runs.push({ kind: 'field', fieldId: ch.dataset.fid }); continue; }
      if (ch.tagName === 'BR') continue;
      var f = { b: fmt.b, i: fmt.i, ul: fmt.ul, strike: fmt.strike, color: fmt.color };
      var tg = ch.tagName;
      if (tg === 'B' || tg === 'STRONG') f.b = true;
      if (tg === 'I' || tg === 'EM') f.i = true;
      if (tg === 'U' || tg === 'INS') f.ul = true;
      if (tg === 'S' || tg === 'STRIKE' || tg === 'DEL') f.strike = true;
      var st = ch.style;
      if (st) {
        if (st.fontWeight === 'bold' || parseInt(st.fontWeight, 10) >= 600) f.b = true;
        if (st.fontStyle === 'italic') f.i = true;
        if ((st.textDecoration || '').indexOf('underline') >= 0) f.ul = true;
        if ((st.textDecoration || '').indexOf('line-through') >= 0) f.strike = true;
      }
      if (ch.dataset && ch.dataset.color) f.color = parseInt(ch.dataset.color, 10);
      if (ch.dataset && ch.dataset.raw) pendRaw = ch.dataset.raw;
      walk(ch, f);
    }
  })(root, { b: false, i: false, ul: false, strike: false, color: 1 });
  return runs;
}

/* ---------- preview ---------- */
function fieldOutput(t, f) {
  if (f.type === 3 && f.choices && f.choices.length) {
    var idx = t.pv[f.id];
    if (idx == null) {
      idx = 0;
      if (f.hasDefault) f.choices.forEach(function (c, i) { if (C.displayToken(c) === String(f.defaultValue).trim()) idx = i; });
    }
    return f.choices[idx] ? (f.choices[idx].value || '') : '';
  }
  if (t.pvText[f.id] != null) return t.pvText[f.id];
  return f.defaultValue != null ? f.defaultValue : '';
}
function renderPreview(t) {
  syncFromDom();
  var host = document.createElement('div'); host.className = 'pv';
  var sheet = document.createElement('div'); sheet.className = 'sheet';
  var d = t.doc;
  d.paragraphs.forEach(function (P, pi) {
    var line = document.createElement('div');
    P.runs.forEach(function (r) {
      if (r.kind === 'text') { line.appendChild(document.createTextNode(r.text)); return; }
      var f = d.fieldMap[r.fieldId]; if (!f) return;
      if (f.type === 3 && f.choices && f.choices.length) {
        var sel = document.createElement('select');
        f.choices.forEach(function (c, i) {
          var o = document.createElement('option');
          o.value = i; o.textContent = C.displayToken(c) || '(blank)'; o.title = c.value || '';
          sel.appendChild(o);
        });
        var idx = 0;
        if (t.pv[f.id] != null) idx = t.pv[f.id];
        else if (f.hasDefault) f.choices.forEach(function (c, i) { if (C.displayToken(c) === String(f.defaultValue).trim()) idx = i; });
        sel.value = idx; sel.title = f.name;
        sel.onchange = function () { t.pv[f.id] = +sel.value; updateOut(); };
        sel.onfocus = function () { S.sel = f.id; renderOutline(); renderInspector(); };
        line.appendChild(sel);
      } else if (f.type === 1) {
        var inp = document.createElement('input');
        inp.className = 'fi'; inp.value = fieldOutput(t, f); inp.title = f.name; inp.placeholder = f.name;
        inp.size = Math.max(8, Math.min(60, inp.value.length || 12));
        inp.oninput = function () { t.pvText[f.id] = inp.value; inp.size = Math.max(8, Math.min(60, inp.value.length || 12)); updateOut(); };
        inp.onfocus = function () { S.sel = f.id; renderOutline(); renderInspector(); };
        line.appendChild(inp);
      } else {
        var sp = document.createElement('span'); sp.className = 'sys'; sp.textContent = '[' + f.name + ']';
        sp.title = 'Fill-in field (type 2)';
        line.appendChild(sp);
      }
    });
    if (!P.runs.length) line.appendChild(document.createElement('br'));
    sheet.appendChild(line);
  });
  host.appendChild(sheet);

  var h = document.createElement('div'); h.className = 'row'; h.style.cssText = 'margin:22px 0 8px';
  h.innerHTML = '<b>Resulting report text</b><span class="sp"></span>';
  var cp = document.createElement('button'); cp.textContent = 'Copy';
  cp.onclick = function () { copyText(out.textContent, cp); };
  var rs = document.createElement('button'); rs.className = 'ghost'; rs.textContent = 'Reset to defaults';
  rs.onclick = function () { t.pv = {}; t.pvText = {}; renderCenter(); };
  h.appendChild(rs); h.appendChild(cp);
  host.appendChild(h);
  var out = document.createElement('pre'); out.className = 'out';
  host.appendChild(out);
  function updateOut() {
    var s = '';
    d.paragraphs.forEach(function (P) {
      P.runs.forEach(function (r) {
        if (r.kind === 'text') s += r.text;
        else { var f = d.fieldMap[r.fieldId]; if (f) s += (f.type === 2 ? '____' : fieldOutput(t, f)); }
      });
      s += '\n';
    });
    out.textContent = s.replace(/\n{3,}/g, '\n\n').trim();
  }
  updateOut();
  return host;
}

/* ---------- source ---------- */
function renderSource(t) {
  syncFromDom();
  var full = C.serializeTemplate(t.doc);
  var xi = full.indexOf('{\\xml}');
  var rtf = xi < 0 ? full : full.slice(0, xi);
  var xml = xi < 0 ? '' : full.slice(xi);
  var bad = C.selfCheck(full);
  var host = document.createElement('div'); host.style.cssText = 'max-width:980px;margin:0 auto';
  var st = document.createElement('div'); st.className = 'row small'; st.style.marginBottom = '10px';
  st.innerHTML = '<span>' + full.length.toLocaleString() + ' bytes · ' + t.doc.fields.length + ' fields</span>' +
    '<span class="sp"></span><span style="color:' + (bad.length ? 'var(--err)' : 'var(--ok)') + '">' +
    (bad.length ? '● ' + bad.length + ' field offset mismatch' : '● every field offset verified against the body text') + '</span>';
  host.appendChild(st);
  [['RTF body', rtf], ['AutoText field definitions (XML)', prettyXml(xml)]].forEach(function (pair) {
    var hd = document.createElement('div'); hd.className = 'row'; hd.style.cssText = 'margin:14px 0 6px';
    hd.innerHTML = '<b>' + pair[0] + '</b><span class="sp"></span>';
    var b = document.createElement('button'); b.className = 'small'; b.textContent = 'Copy';
    b.onclick = function () { copyText(pair[1], b); };
    hd.appendChild(b); host.appendChild(hd);
    var pre = document.createElement('pre'); pre.className = 'out'; pre.textContent = pair[1];
    pre.style.maxHeight = '46vh'; pre.style.overflow = 'auto';
    host.appendChild(pre);
  });
  return host;
}
function prettyXml(x) {
  if (!x) return '';
  return x.replace(/></g, '>\n<').replace(/\n<(\/?)(name|value|defaultvalue|choice|string|range)/g, '<$1$2');
}

/* ---------- inspector ---------- */
function renderInspector() {
  var host = $('#insp'); host.innerHTML = '';
  var t = cur(); if (!t) { host.innerHTML = '<div class="empty">Nothing open</div>'; return; }
  var f = t.doc.fieldMap[S.sel];
  if (!f) { host.innerHTML = '<div class="empty">Select a field in the report or the list on the left.</div>'; return; }

  var head = document.createElement('div'); head.className = 'f';
  head.innerHTML = '<label class="lbl">Field name</label>';
  var nm = document.createElement('input'); nm.value = f.name;
  nm.onchange = function () {
    if (nm.value === f.name) return;
    pushUndo(); f.name = nm.value; refreshChips(f.id); renderOutline(); renderStatus();
  };
  head.appendChild(nm);
  var tr = document.createElement('div'); tr.style.marginTop = '10px';
  tr.innerHTML = '<label class="lbl">Type</label>';
  var ty = document.createElement('select');
  [1, 2, 3].forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = TYPE[n] + ' (' + n + ')'; ty.appendChild(o); });
  ty.value = f.type;
  ty.onchange = function () {
    pushUndo();
    var n = +ty.value;
    if (n === 3 && (!f.choices || !f.choices.length)) {
      f.choices = [{ name: 'normal', value: f.defaultValue || 'Normal.' }, { name: 'abnormal', value: '' }];
      f.hasDefault = true; f.defaultValue = 'normal';
    }
    if (n !== 3) { f.choices = null; }
    f.type = n; refreshChips(f.id); renderInspector(); renderOutline(); renderStatus();
  };
  tr.appendChild(ty);
  var hint = document.createElement('div'); hint.className = 'small mut'; hint.style.marginTop = '5px';
  hint.textContent = TYPE_HINT[f.type];
  tr.appendChild(hint);
  head.appendChild(tr);
  host.appendChild(head);

  if (f.type === 3) host.appendChild(choicesPanel(t, f));
  else host.appendChild(defaultPanel(t, f));

  host.appendChild(propsPanel(t, f));
  host.appendChild(synPanel(t, f));

  var foot = document.createElement('div'); foot.className = 'f row';
  var dup = document.createElement('button'); dup.textContent = 'Duplicate field';
  dup.onclick = function () {
    pushUndo();
    var copy = JSON.parse(JSON.stringify(f));
    copy.id = 'f' + (t.doc.nextId++); copy.name = f.name + ' 2';
    t.doc.fields.push(copy); t.doc.fieldMap[copy.id] = copy;
    var body = $('#body');
    var chip = $('.chip[data-fid="' + f.id + '"]');
    if (chip) { var sp = document.createTextNode(' '); chip.parentNode.insertBefore(sp, chip.nextSibling); chip.parentNode.insertBefore(chipEl(copy), sp.nextSibling); }
    S.sel = copy.id; syncFromDom(); renderOutline(); renderInspector(); renderStatus();
  };
  var del = document.createElement('button'); del.textContent = 'Remove from report';
  del.style.color = 'var(--err)';
  del.onclick = function () {
    if (!confirm('Remove field "' + f.name + '" from this template?')) return;
    pushUndo();
    $$('.chip[data-fid="' + f.id + '"]').forEach(function (c) { c.remove(); });
    t.doc.fields = t.doc.fields.filter(function (x) { return x.id !== f.id; });
    delete t.doc.fieldMap[f.id];
    S.sel = null; syncFromDom(); renderOutline(); renderInspector(); renderStatus();
  };
  foot.appendChild(dup); foot.appendChild(del);
  host.appendChild(foot);
}

function defaultPanel(t, f) {
  var w = document.createElement('div'); w.className = 'f';
  w.innerHTML = '<label class="lbl">Default text</label>';
  var ta = document.createElement('textarea'); ta.rows = 4; ta.value = f.defaultValue || '';
  ta.placeholder = 'Text pre-filled into the report (leave blank for none)';
  ta.onchange = function () {
    pushUndo();
    if (ta.value === '') { f.hasDefault = false; f.defaultValue = null; }
    else { f.hasDefault = true; f.defaultValue = ta.value; }
    refreshChips(f.id); renderStatus();
  };
  w.appendChild(ta);
  return w;
}

function choicesPanel(t, f) {
  var w = document.createElement('div'); w.className = 'f';
  var hd = document.createElement('div'); hd.className = 'row'; hd.style.marginBottom = '8px';
  hd.innerHTML = '<span class="lbl" style="margin:0">Pick list · ' + f.choices.length + ' choices</span><span class="sp"></span>';
  var bulk = document.createElement('button'); bulk.className = 'small ghost'; bulk.textContent = 'Bulk edit';
  var cpy = document.createElement('button'); cpy.className = 'small ghost'; cpy.textContent = 'Copy';
  cpy.title = 'Copy this whole list, to paste into another field or template';
  cpy.onclick = function () { S.clip = JSON.parse(JSON.stringify(f.choices)); cpy.textContent = 'Copied'; setTimeout(function () { cpy.textContent = 'Copy'; }, 1200); renderInspector(); };
  hd.appendChild(cpy);
  if (S.clip) {
    var pst = document.createElement('button'); pst.className = 'small ghost'; pst.textContent = 'Paste ' + S.clip.length;
    pst.onclick = function () { pushUndo(); f.choices = JSON.parse(JSON.stringify(S.clip)); refreshChips(f.id); renderInspector(); renderStatus(); };
    hd.appendChild(pst);
  }
  hd.appendChild(bulk);
  w.appendChild(hd);

  var listWrap = document.createElement('div');
  var bulkWrap = document.createElement('div'); bulkWrap.className = 'hide';
  bulk.onclick = function () {
    var showing = !bulkWrap.classList.contains('hide');
    bulkWrap.classList.toggle('hide', !showing ? false : true);
    listWrap.classList.toggle('hide', !showing);
    bulk.textContent = showing ? 'Bulk edit' : 'Back to list';
    if (!showing) ta.value = f.choices.map(function (c) { return (c.name || '') + ' | ' + (c.value || '').replace(/\n/g, '\\n'); }).join('\n');
  };
  var ta = document.createElement('textarea'); ta.rows = 12; ta.className = 'mono'; ta.style.fontSize = '12px';
  ta.placeholder = 'label | statement text\nnormal | No acute abnormality.';
  var apply = document.createElement('button'); apply.className = 'primary small'; apply.textContent = 'Apply list';
  apply.style.marginTop = '8px';
  apply.onclick = function () {
    pushUndo();
    f.choices = ta.value.split('\n').filter(function (l) { return l.trim() !== ''; }).map(function (l) {
      var i = l.indexOf('|');
      if (i < 0) return { name: '', value: l.trim() };
      return { name: l.slice(0, i).trim(), value: l.slice(i + 1).replace(/^\s/, '').replace(/\\n/g, '\n') };
    });
    if (f.hasDefault) {
      var ok = f.choices.some(function (c) { return C.displayToken(c) === String(f.defaultValue).trim(); });
      if (!ok) f.defaultValue = C.displayToken(f.choices[0] || { name: '', value: '' });
    }
    refreshChips(f.id); renderInspector(); renderStatus();
  };
  var bhint = document.createElement('div'); bhint.className = 'small mut'; bhint.style.margin = '6px 0';
  bhint.textContent = 'One choice per line: the short label the radiologist says, a pipe, then the statement inserted into the report. Use \\n for a line break inside a statement.';
  bulkWrap.appendChild(bhint); bulkWrap.appendChild(ta); bulkWrap.appendChild(apply);

  f.choices.forEach(function (c, idx) { listWrap.appendChild(choiceRow(t, f, c, idx)); });

  var add = document.createElement('button'); add.className = 'small'; add.textContent = '+ Add choice';
  add.onclick = function () { pushUndo(); f.choices.push({ name: '', value: '' }); refreshChips(f.id); renderInspector(); renderStatus(); };
  listWrap.appendChild(add);

  var nodef = document.createElement('label'); nodef.className = 'chk small'; nodef.style.marginTop = '8px';
  nodef.innerHTML = '<input type="checkbox"' + (f.hasDefault ? '' : ' checked') + '><span class="t">No default — nothing is pre-selected<span class="d">PowerScribe leaves the field open until it is dictated.</span></span>';
  nodef.querySelector('input').onchange = function (e) {
    pushUndo();
    if (e.target.checked) { f.hasDefault = false; f.defaultValue = null; }
    else { f.hasDefault = true; f.defaultValue = C.displayToken(f.choices[0] || { name: 'normal', value: '' }); }
    refreshChips(f.id); renderInspector(); renderStatus();
  };
  listWrap.appendChild(nodef);

  w.appendChild(listWrap); w.appendChild(bulkWrap);
  return w;
}

function choiceRow(t, f, c, idx) {
  var tok = C.displayToken(c);
  var isDef = f.hasDefault && String(f.defaultValue).trim() === tok;
  var row = document.createElement('div'); row.className = 'ch' + (isDef ? ' def' : '');
  row.draggable = false;

  var top = document.createElement('div'); top.className = 'top';
  var hnd = document.createElement('span'); hnd.className = 'hnd'; hnd.textContent = '⠿'; hnd.title = 'Drag to reorder';
  hnd.onmousedown = function () { row.draggable = true; };
  hnd.onmouseup = function () { row.draggable = false; };
  top.appendChild(hnd);
  var up = document.createElement('button'); up.className = 'icon ghost'; up.textContent = '↑'; up.title = 'Move up';
  up.disabled = idx === 0;
  up.onclick = function () { pushUndo(); f.choices.splice(idx - 1, 0, f.choices.splice(idx, 1)[0]); refreshChips(f.id); renderInspector(); renderStatus(); };
  var dn = document.createElement('button'); dn.className = 'icon ghost'; dn.textContent = '↓'; dn.title = 'Move down';
  dn.disabled = idx === f.choices.length - 1;
  dn.onclick = function () { pushUndo(); f.choices.splice(idx + 1, 0, f.choices.splice(idx, 1)[0]); refreshChips(f.id); renderInspector(); renderStatus(); };
  top.appendChild(up); top.appendChild(dn);

  var lab = document.createElement('input'); lab.className = 'lab'; lab.value = c.name || '';
  lab.placeholder = 'label (spoken)';
  lab.title = 'The short label. If blank, the statement text itself is used as the label.';
  lab.onchange = function () {
    if (lab.value === c.name) return;
    pushUndo();
    var was = C.displayToken(c);
    c.name = lab.value;
    if (f.hasDefault && String(f.defaultValue).trim() === was) f.defaultValue = C.displayToken(c);
    refreshChips(f.id); renderInspector(); renderStatus();
  };
  top.appendChild(lab);

  var db = document.createElement('button'); db.className = 'icon ghost';
  db.innerHTML = isDef ? '<span class="pill">default</span>' : '☆';
  db.title = 'Make this the default choice';
  db.onclick = function () { pushUndo(); f.hasDefault = true; f.defaultValue = C.displayToken(c); refreshChips(f.id); renderInspector(); renderStatus(); };
  top.appendChild(db);

  var dup = document.createElement('button'); dup.className = 'icon ghost'; dup.textContent = '⧉'; dup.title = 'Duplicate';
  dup.onclick = function () { pushUndo(); f.choices.splice(idx + 1, 0, { name: c.name, value: c.value }); refreshChips(f.id); renderInspector(); renderStatus(); };
  top.appendChild(dup);

  var del = document.createElement('button'); del.className = 'icon ghost'; del.textContent = '✕'; del.title = 'Delete choice';
  del.onclick = function () {
    pushUndo(); f.choices.splice(idx, 1);
    if (f.hasDefault && !f.choices.some(function (x) { return C.displayToken(x) === String(f.defaultValue).trim(); }))
      f.defaultValue = f.choices.length ? C.displayToken(f.choices[0]) : null;
    if (!f.choices.length) f.hasDefault = false;
    refreshChips(f.id); renderInspector(); renderStatus();
  };
  top.appendChild(del);
  row.appendChild(top);

  var ta = document.createElement('textarea'); ta.value = c.value || '';
  ta.placeholder = 'statement inserted into the report';
  ta.rows = Math.max(1, Math.min(6, Math.ceil((c.value || '').length / 46)));
  ta.onchange = function () {
    if (ta.value === c.value) return;
    pushUndo();
    var was = C.displayToken(c);
    c.value = ta.value;
    if (f.hasDefault && String(f.defaultValue).trim() === was && !(c.name || '').trim()) f.defaultValue = C.displayToken(c);
    refreshChips(f.id); renderStatus();
  };
  row.appendChild(ta);

  row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', idx); row.classList.add('drag'); });
  row.addEventListener('dragend', function () { row.classList.remove('drag'); row.draggable = false; });
  row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('over'); });
  row.addEventListener('dragleave', function () { row.classList.remove('over'); });
  row.addEventListener('drop', function (e) {
    e.preventDefault(); row.classList.remove('over');
    var from = +e.dataTransfer.getData('text/plain');
    if (isNaN(from) || from === idx) return;
    pushUndo();
    var m = f.choices.splice(from, 1)[0];
    f.choices.splice(idx, 0, m);
    refreshChips(f.id); renderInspector(); renderStatus();
  });
  return row;
}

function propsPanel(t, f) {
  var w = document.createElement('div'); w.className = 'f';
  w.innerHTML = '<label class="lbl">Field properties</label>';
  f.props.forEach(function (p) {
    var isBool = p.value === 'True' || p.value === 'False';
    if (isBool) {
      var l = document.createElement('label'); l.className = 'chk';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = p.value === 'True';
      cb.onchange = function () { pushUndo(); p.value = cb.checked ? 'True' : 'False'; renderOutline(); renderStatus(); };
      var sp = document.createElement('span'); sp.className = 't';
      sp.innerHTML = esc(p.name) + (PROP_HINT[p.name] ? '<span class="d">' + esc(PROP_HINT[p.name]) + '</span>' : '');
      l.appendChild(cb); l.appendChild(sp); w.appendChild(l);
    } else {
      var d = document.createElement('div'); d.style.margin = '6px 0';
      d.innerHTML = '<label class="lbl">' + esc(p.name) + '</label>';
      var inp = document.createElement('input'); inp.value = p.value || '';
      inp.onchange = function () { pushUndo(); p.value = inp.value; };
      d.appendChild(inp); w.appendChild(d);
    }
  });
  return w;
}

function synPanel(t, f) {
  var w = document.createElement('div'); w.className = 'f';
  w.innerHTML = '<label class="lbl">Voice synonyms</label>';
  var inp = document.createElement('input');
  inp.value = (f.synonyms || []).join(', ');
  inp.placeholder = 'e.g. heart, cardiac';
  inp.title = 'Alternative spoken names for this field, comma separated.';
  inp.onchange = function () {
    pushUndo();
    var v = inp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    f.synonyms = v.length ? v : null;
  };
  w.appendChild(inp);
  return w;
}

/* ---------- misc ---------- */
function copyText(s, btn) {
  var done = function () { if (btn) { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1200); } };
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(s).then(done, function () { fallback(); }); return; }
  fallback();
  function fallback() {
    var ta = document.createElement('textarea'); ta.value = s;
    ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); done(); } catch (e) { alert('Copy failed — select the text manually.'); }
    ta.remove();
  }
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

$('#helpBtn').onclick = function () { $('#help').classList.remove('hide'); };
$('#helpX').onclick = function () { $('#help').classList.add('hide'); };
$('#help').onclick = function (e) { if (e.target.id === 'help') $('#help').classList.add('hide'); };
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('#help').classList.add('hide'); });
$('#openBtn').onclick = function () { $('#file').click(); };
$('#file').onchange = function (e) { openFiles(e.target.files); e.target.value = ''; };
$('#saveBtn').onclick = save;
$('#search').oninput = function (e) { S.filter = e.target.value; renderOutline(); };
$('#addField').onclick = insertFieldAtCaret;
$('#showLists').onchange = function (e) { S.showLists = e.target.checked; if (S.mode === 'edit') { syncFromDom(); renderCenter(); } };
$$('#modeseg button').forEach(function (b) {
  b.onclick = function () {
    if (S.mode === 'edit') syncFromDom();
    S.mode = b.dataset.mode;
    $$('#modeseg button').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderCenter(); renderStatus();
  };
});
document.addEventListener('keydown', function (e) {
  var mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#file').click(); }
  if (mod && e.key.toLowerCase() === 'z') {
    var inBody = document.activeElement && document.activeElement.id === 'body';
    if (!inBody) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  }
});
window.addEventListener('beforeunload', function (e) {
  if (S.tpls.some(function (t) { return t.dirty; })) { e.preventDefault(); e.returnValue = ''; }
});
var dz = $('#drop'), dragDepth = 0;
window.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; dz.classList.remove('hide'); });
window.addEventListener('dragleave', function (e) { e.preventDefault(); if (--dragDepth <= 0) dz.classList.add('hide'); });
window.addEventListener('dragover', function (e) { e.preventDefault(); });
window.addEventListener('drop', function (e) {
  e.preventDefault(); dragDepth = 0; dz.classList.add('hide');
  if (e.dataTransfer.files && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});
document.addEventListener('click', function (e) {
  var b = $('.issues');
  if (b && !b.contains(e.target) && !(e.target.closest && e.target.closest('#vsum'))) b.remove();
});
renderAll();
})();
