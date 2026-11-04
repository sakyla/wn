var state = {
  date: '',
  dayType: '推',
  exercises: [],
  sourceDate: null,
  notes: [],
  lastDay: null
};
var DRAFT_KEY = 'wl_draft_v1';
var BOOT_KEY = 'wn_boot';
var PLAN_KEY = 'wn_plan';
var QUEUE_KEY = 'wn_q';
var URL_KEY = 'wn_url';
var KEY_KEY = 'wn_key';
var DEFAULT_ORDER = ['推', '腿', '有氧', '拉', '補量'];
var dirty = false;
var draftEpoch = 0;
var serverTimer = null;
var inflightId = null;
var flushing = false;
var retryTimer = null;
var bootTimer = null;
var booted = false;
var itemWaiters = {};

function $(id) { return document.getElementById(id); }

function showToast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(function () { t.className = 'toast'; }, 5000);
}

function toInputDate(s) {
  if (!s) return '';
  var m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return s;
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}
function fromInputDate(s) {
  if (!s) return '';
  var m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s;
  return m[1] + '/' + parseInt(m[2], 10) + '/' + parseInt(m[3], 10);
}

function setLoading(on) {
  $('app').classList.toggle('loading', !!on);
  var g = $('btnGenerate');
  var s = $('btnSave');
  if (on || g.dataset.busy !== '1') g.disabled = !!on;
  if (on || s.dataset.busy !== '1') s.disabled = !!on;
}

function configured() {
  try { return !!(localStorage.getItem(URL_KEY) && localStorage.getItem(KEY_KEY)); }
  catch (e) { return false; }
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}

function setNet(text) {
  var el = $('net');
  if (el) el.textContent = text || '';
}

function api(action, payload) {
  var url = '';
  var key = '';
  try {
    url = localStorage.getItem(URL_KEY) || '';
    key = localStorage.getItem(KEY_KEY) || '';
  } catch (e) {}
  if (!url || !key) return Promise.reject(new Error('請填網址與金鑰'));
  return fetch(url, {
    method: 'POST',
    redirect: 'follow',
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: key, action: action, payload: payload })
  }).then(function (res) {
    return res.text();
  }).then(function (text) {
    try { return JSON.parse(text); }
    catch (e) { throw new Error(text ? String(text).slice(0, 180) : 'bad response'); }
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readQueue() {
  var q = readJSON(QUEUE_KEY);
  return Array.isArray(q) ? q : [];
}

function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
}

function watchItem(id) {
  return new Promise(function (resolve) {
    if (!itemWaiters[id]) itemWaiters[id] = [];
    itemWaiters[id].push(resolve);
  });
}

function settleItem(id, result) {
  var list = itemWaiters[id];
  if (!list) return;
  delete itemWaiters[id];
  for (var i = 0; i < list.length; i++) list[i](result);
}

function moveWaiters(fromId, toId) {
  var list = itemWaiters[fromId];
  if (!list || fromId === toId) return;
  delete itemWaiters[fromId];
  if (!itemWaiters[toId]) itemWaiters[toId] = [];
  itemWaiters[toId] = itemWaiters[toId].concat(list);
}

function scheduleRetry(item) {
  var n = (item.tries || 0) + 1;
  var q = readQueue();
  for (var i = 0; i < q.length; i++) {
    if (q[i].id === item.id) q[i].tries = n;
  }
  writeQueue(q);
  if (retryTimer) return;
  var wait = Math.min(30000, 2000 * Math.pow(2, n - 1));
  retryTimer = setTimeout(function () {
    retryTimer = null;
    kickQueue();
  }, wait);
}

function markTold(item) {
  var q = readQueue();
  for (var i = 0; i < q.length; i++) {
    if (q[i].id === item.id) q[i].told = true;
  }
  writeQueue(q);
}

function dropItem(id) {
  writeQueue(readQueue().filter(function (x) { return x.id !== id; }));
}

function enqueueClear() {
  var q = readQueue().filter(function (x) { return x.type !== 'draft' && x.type !== 'clearDraft'; });
  q.push({ type: 'clearDraft', id: uid() });
  writeQueue(q);
  kickQueue();
}

function onSessionSaved(res) {
  draftEpoch++;
  if (serverTimer) { clearTimeout(serverTimer); serverTimer = null; }
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  try { localStorage.removeItem(PLAN_KEY); } catch (e) {}
  writeQueue(readQueue().filter(function (x) { return x.type !== 'draft'; }));
  showToast('已寫入 ' + res.range + '（' + res.mode + '，' + res.rows + ' 列）');
  enqueueClear();
}

function kickQueue() {
  if (flushing) return;
  var q = readQueue();
  if (!q.length) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    return;
  }
  if (!configured()) return;
  var item = q[0];
  flushing = true;
  inflightId = item.id;
  setNet('同步中');
  var req;
  if (item.type === 'draft') req = api('saveDraft', item.payload);
  else if (item.type === 'clearDraft') req = api('clearDraft', null);
  else req = api('saveSession', item.payload);
  req.then(function (res) {
    flushing = false;
    inflightId = null;
    if (!res || res.error === '未授權') {
      if (!item.told) {
        markTold(item);
        showToast((res && res.error) || '未授權', true);
      }
      setNet('未授權');
      settleItem(item.id, { ok: false, error: (res && res.error) || '未授權' });
      return;
    }
    if (item.type === 'session' && res.needConfirm) {
      dropItem(item.id);
      if (confirm(res.error + '\n\n按確定覆蓋該日，取消則不寫入。')) {
        var next = JSON.parse(JSON.stringify(item.payload));
        next.overwrite = true;
        var again = { type: 'session', id: uid(), payload: next };
        var qq = readQueue();
        qq.unshift(again);
        writeQueue(qq);
        moveWaiters(item.id, again.id);
      } else {
        settleItem(item.id, { cancel: true });
        if (!readQueue().length) setNet('已同步');
      }
      kickQueue();
      return;
    }
    if (res.ok === false) {
      if (!item.told) {
        markTold(item);
        if (item.type === 'draft' && item.manual) showToast('雲端草稿儲存失敗，只存在本機', true);
        else if (item.type === 'session') showToast(res.error || '寫入失敗', true);
      }
      setNet('待重試');
      scheduleRetry(item);
      settleItem(item.id, { ok: false, retry: true, error: res.error || '' });
      return;
    }
    if (item.type === 'draft' && item.epoch !== draftEpoch) {
      dropItem(item.id);
      enqueueClear();
      settleItem(item.id, { cancel: true });
      return;
    }
    dropItem(item.id);
    if (item.type === 'draft' && item.manual) {
      showToast('草稿已存到雲端（關閉瀏覽器、換裝置都還在）');
    }
    if (item.type === 'session') onSessionSaved(res);
    if (!readQueue().length) setNet('已同步');
    settleItem(item.id, { ok: true });
    kickQueue();
  }).catch(function (err) {
    flushing = false;
    inflightId = null;
    if (!item.told) {
      markTold(item);
      if (item.type === 'draft' && item.manual) showToast('雲端草稿儲存失敗，只存在本機', true);
      else if (item.type === 'session') showToast(String(err && err.message || err), true);
    }
    setNet('待重試');
    scheduleRetry(item);
    settleItem(item.id, { ok: false, retry: true, error: String(err && err.message || err) });
  });
}

function enqueueDraft(d, manual) {
  var dropped = [];
  var id = uid();
  var q = readQueue().filter(function (x) {
    if (x.type !== 'draft') return true;
    if (x.id === inflightId) return true;
    dropped.push(x.id);
    return false;
  });
  q.push({ type: 'draft', id: id, payload: d, manual: !!manual, epoch: draftEpoch });
  writeQueue(q);
  setNet('同步中');
  for (var i = 0; i < dropped.length; i++) moveWaiters(dropped[i], id);
  kickQueue();
  return id;
}

function enqueueSession(payload) {
  var item = { type: 'session', id: uid(), payload: payload };
  var q = readQueue();
  q.push(item);
  writeQueue(q);
  setNet('同步中');
  kickQueue();
  return item.id;
}

function emptySet() {
  return { weight: '', reps: '', sec: '', rpe: '', rest: '', principle: '', feel: '' };
}

function fillTypes(order) {
  var sel = $('dayType');
  var cur = state.dayType || sel.value;
  sel.innerHTML = '';
  (order || DEFAULT_ORDER).forEach(function (t) {
    var o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
  state.dayType = sel.value || cur || '推';
}

function render() {
  $('date').value = toInputDate(state.date);
  $('dayType').value = state.dayType;

  var meta = [];
  if (state.lastDay) meta.push('上次訓練：' + state.lastDay.date + '（' + state.lastDay.dayType + '）');
  if (state.sourceDate) meta.push('模板來源：' + state.sourceDate);
  $('meta').textContent = meta.join(' · ');

  var notesEl = $('sessionNotes');
  notesEl.innerHTML = '';
  (state.notes || []).forEach(function (n) {
    var d = document.createElement('div');
    d.className = 'note';
    d.textContent = n;
    notesEl.appendChild(d);
  });

  var root = $('exercises');
  root.innerHTML = '';
  $('empty').style.display = state.exercises.length ? 'none' : 'block';

  state.exercises.forEach(function (ex, ei) {
    var card = document.createElement('div');
    card.className = 'card';

    var hd = document.createElement('div');
    hd.className = 'card-hd';
    var nameWrap = document.createElement('div');
    nameWrap.className = 'grow';
    var nameLab = document.createElement('label');
    nameLab.textContent = '動作 ' + (ei + 1);
    var nameIn = document.createElement('input');
    nameIn.className = 'name';
    nameIn.value = ex.name || '';
    nameIn.placeholder = '動作名稱';
    nameIn.addEventListener('input', function () { ex.name = nameIn.value; saveDraftSilent(); });
    nameWrap.appendChild(nameLab);
    nameWrap.appendChild(nameIn);
    hd.appendChild(nameWrap);

    var btns = document.createElement('div');
    btns.className = 'row';
    btns.style.marginTop = '22px';
    btns.appendChild(iconBtn('↑', function () { moveEx(ei, -1); }));
    btns.appendChild(iconBtn('↓', function () { moveEx(ei, 1); }));
    hd.appendChild(btns);
    card.appendChild(hd);

    if (ex.progressNote) {
      var pn = document.createElement('div');
      pn.className = ex.ambiguous ? 'warn-note' : 'note';
      pn.textContent = ex.progressNote;
      card.appendChild(pn);
    }
    if (ex.lastSets && ex.lastSets.length) {
      var last = document.createElement('div');
      last.className = 'last';
      last.textContent = '上次：' + formatSets(ex.lastSets);
      card.appendChild(last);
    }

    var prinLab = document.createElement('label');
    prinLab.textContent = '原則';
    prinLab.style.marginTop = '8px';
    var prin = document.createElement('textarea');
    prin.value = ex.principle || '';
    prin.placeholder = '原則（可空）';
    prin.addEventListener('input', function () { ex.principle = prin.value; saveDraftSilent(); });
    card.appendChild(prinLab);
    card.appendChild(prin);

    (ex.sets || []).forEach(function (set, si) {
      card.appendChild(renderSet(ex, ei, set, si));
    });

    var actRow = document.createElement('div');
    actRow.className = 'row';
    actRow.style.marginTop = '8px';
    actRow.style.flexWrap = 'nowrap';
    var delEx = document.createElement('button');
    delEx.type = 'button';
    delEx.className = 'btn btn-danger btn-sm';
    delEx.textContent = '刪除動作';
    delEx.onclick = function () {
      if (confirm('確定要刪除「' + (ex.name || '此動作') + '」整個動作嗎？')) {
        state.exercises.splice(ei, 1);
        render();
        saveDraftSilent();
      }
    };
    actRow.appendChild(delEx);
    var addSet = document.createElement('button');
    addSet.type = 'button';
    addSet.className = 'btn btn-ghost btn-sm grow';
    addSet.textContent = '＋ 新增一組';
    addSet.onclick = function () {
      var prev = ex.sets[ex.sets.length - 1];
      ex.sets.push(prev ? Object.assign({}, prev, { rpe: '', feel: '' }) : emptySet());
      render();
      saveDraftSilent();
    };
    actRow.appendChild(addSet);
    card.appendChild(actRow);

    root.appendChild(card);
  });
}

function iconBtn(label, fn, danger) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm btn-icon ' + (danger ? 'btn-danger' : 'btn-ghost');
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function formatSets(sets) {
  return sets.map(function (s) {
    function has(v) { return v !== '' && v !== null && v !== undefined; }
    var wr = '';
    if (has(s.weight)) wr += s.weight;
    if (has(s.reps)) wr += '×' + s.reps;
    var parts = [];
    if (wr) parts.push(wr);
    if (has(s.sec)) parts.push(s.sec + '秒');
    if (has(s.rpe)) parts.push('RPE ' + s.rpe);
    return parts.join(' ') || '—';
  }).join(' / ');
}

function renderSet(ex, ei, set, si) {
  var box = document.createElement('div');
  box.className = 'set';
  var top = document.createElement('div');
  top.className = 'row';
  top.innerHTML = '<div class="grow muted">第 ' + (si + 1) + ' 組</div>';
  var del = iconBtn('刪組', function () {
    if (!confirm('確定要刪除「' + (ex.name || '此動作') + '」的第 ' + (si + 1) + ' 組嗎？')) return;
    ex.sets.splice(si, 1);
    if (!ex.sets.length) ex.sets.push(emptySet());
    render();
    saveDraftSilent();
  }, true);
  top.appendChild(del);
  box.appendChild(top);

  var grid = document.createElement('div');
  grid.className = 'set-grid';

  grid.appendChild(numField('重量', set, 'weight', true));
  grid.appendChild(numField('次數', set, 'reps', true));
  grid.appendChild(numField('秒數', set, 'sec', false));
  grid.appendChild(numField('RPE', set, 'rpe', false));
  grid.appendChild(textField('組間', set, 'rest', false));
  Array.prototype.forEach.call(grid.children, function (c) { c.classList.add('big'); });
  grid.appendChild(textField('體感', set, 'feel', false));

  box.appendChild(grid);
  return box;
}

function numField(label, obj, key, steppable) {
  var wrap = document.createElement('div');
  var lab = document.createElement('label');
  lab.textContent = label;
  wrap.appendChild(lab);
  if (steppable) {
    var ste = document.createElement('div');
    ste.className = 'stepper';
    var minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'btn btn-ghost btn-icon btn-sm';
    minus.textContent = '−';
    minus.onclick = function () {
      var n = parseFloat(obj[key]);
      if (isNaN(n)) n = 0;
      var step = key === 'weight' ? 1 : 1;
      obj[key] = +(n - step).toFixed(2);
      if (obj[key] < 0) obj[key] = 0;
      render();
      saveDraftSilent();
    };
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.inputMode = 'decimal';
    inp.value = obj[key] === null || obj[key] === undefined ? '' : obj[key];
    inp.addEventListener('change', function () {
      obj[key] = inp.value === '' ? '' : parseFloat(inp.value);
      saveDraftSilent();
    });
    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'btn btn-ghost btn-icon btn-sm';
    plus.textContent = '＋';
    plus.onclick = function () {
      var n = parseFloat(obj[key]);
      if (isNaN(n)) n = 0;
      obj[key] = +(n + 1).toFixed(2);
      render();
      saveDraftSilent();
    };
    ste.appendChild(minus);
    ste.appendChild(inp);
    ste.appendChild(plus);
    wrap.appendChild(ste);
  } else {
    var inp2 = document.createElement('input');
    inp2.type = 'number';
    inp2.inputMode = 'decimal';
    inp2.value = obj[key] === null || obj[key] === undefined ? '' : obj[key];
    inp2.addEventListener('change', function () {
      obj[key] = inp2.value === '' ? '' : parseFloat(inp2.value);
      saveDraftSilent();
    });
    wrap.appendChild(inp2);
  }
  return wrap;
}

function textField(label, obj, key) {
  var wrap = document.createElement('div');
  wrap.className = key === 'feel' ? 'full' : '';
  var lab = document.createElement('label');
  lab.textContent = label;
  var inp = document.createElement('input');
  inp.type = 'text';
  inp.value = obj[key] || '';
  inp.addEventListener('input', function () { obj[key] = inp.value; saveDraftSilent(); });
  wrap.appendChild(lab);
  wrap.appendChild(inp);
  return wrap;
}

function moveEx(i, dir) {
  var j = i + dir;
  if (j < 0 || j >= state.exercises.length) return;
  var t = state.exercises[i];
  state.exercises[i] = state.exercises[j];
  state.exercises[j] = t;
  render();
  saveDraftSilent();
}

function draftObj() {
  return {
    date: state.date,
    dayType: state.dayType,
    exercises: state.exercises,
    sourceDate: state.sourceDate,
    notes: state.notes,
    savedAt: Date.now()
  };
}

function writeLocalDraft(d) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) {}
}

function saveDraftSilent() {
  dirty = true;
  var d = draftObj();
  writeLocalDraft(d);
  if (serverTimer) clearTimeout(serverTimer);
  serverTimer = setTimeout(function () { enqueueDraft(draftObj(), false); }, 1500);
}

function applyDraft(d) {
  if (!d || !d.exercises) return false;
  state.date = d.date || state.date;
  state.dayType = d.dayType || state.dayType;
  state.exercises = d.exercises;
  state.sourceDate = d.sourceDate || null;
  state.notes = d.notes || [];
  return true;
}

function loadDraft(serverDraft) {
  var local = readJSON(DRAFT_KEY);
  var pick = local;
  if (serverDraft && serverDraft.exercises &&
      (!local || !local.exercises || (serverDraft.savedAt || 0) >= (local.savedAt || 0))) {
    pick = serverDraft;
  }
  var ok = applyDraft(pick);
  if (ok && pick === serverDraft) writeLocalDraft(pick);
  return ok;
}

function restoreLocal() {
  var plan = readJSON(PLAN_KEY);
  var draft = readJSON(DRAFT_KEY);
  var pick = null;
  if (plan && plan.exercises && plan.exercises.length) pick = plan;
  if (draft && draft.exercises && draft.exercises.length &&
      (!pick || (draft.savedAt || 0) >= (pick.savedAt || 0))) pick = draft;
  if (!pick) return false;
  return applyDraft(pick);
}

function rememberPlan() {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(draftObj())); } catch (e) {}
}

function openSetup(canBack) {
  try {
    $('apiUrl').value = localStorage.getItem(URL_KEY) || '';
    $('apiKey').value = localStorage.getItem(KEY_KEY) || '';
  } catch (e) {
    $('apiUrl').value = '';
    $('apiKey').value = '';
  }
  document.documentElement.classList.add('need-setup');
  document.documentElement.classList.toggle('can-back', !!canBack);
}

function closeSetup() {
  document.documentElement.classList.remove('need-setup');
  document.documentElement.classList.remove('can-back');
}

function failLabel(res) {
  if (res && res.retry) return '⚠ 失敗，已排入重試';
  var msg = res && res.error ? String(res.error).replace(/\s+/g, ' ').trim() : '';
  if (!msg) return '⚠ 失敗';
  if (msg.length > 18) msg = msg.slice(0, 18) + '…';
  if (msg.charAt(0) === '⚠') return msg;
  return '⚠ ' + msg;
}

function armButton(btn, promise, save) {
  if (!btn || btn.dataset.busy === '1') return;
  var original = btn.textContent;
  var token = {};
  var pending = true;
  btn._fbToken = token;
  btn.dataset.busy = '1';
  btn.classList.add('tap');
  setTimeout(function () {
    if (btn._fbToken !== token || !pending) return;
    btn.classList.remove('tap');
    btn.disabled = true;
    btn.classList.add('busy');
    btn.classList.remove('hold');
    btn.textContent = '';
    var sp = document.createElement('span');
    sp.className = 'spin';
    sp.setAttribute('aria-hidden', 'true');
    btn.appendChild(sp);
    btn.appendChild(document.createTextNode('處理中…'));
  }, 120);
  function restore(label, ms) {
    pending = false;
    if (btn._fbToken !== token) return;
    btn.classList.remove('tap', 'busy');
    btn.classList.add('hold');
    btn.disabled = true;
    btn.textContent = label;
    setTimeout(function () {
      if (btn._fbToken !== token) return;
      btn.textContent = original;
      btn.disabled = false;
      btn.classList.remove('busy', 'hold', 'tap');
      delete btn.dataset.busy;
      btn._fbToken = null;
    }, ms);
  }
  function clearNow() {
    pending = false;
    if (btn._fbToken !== token) return;
    btn.textContent = original;
    btn.disabled = false;
    btn.classList.remove('busy', 'hold', 'tap');
    delete btn.dataset.busy;
    btn._fbToken = null;
  }
  Promise.resolve(promise).then(function (res) {
    if (res && res.cancel) { clearNow(); return; }
    if (res && res.ok) restore(save ? '✓ 已儲存' : '✓ 完成', 1500);
    else restore(failLabel(res), 2500);
  }, function () {
    restore('⚠ 失敗，已排入重試', 2500);
  });
}

function pressBtn(e) {
  var t = e.target;
  if (!t) return;
  if (t.nodeType !== 1) t = t.parentElement;
  if (!t || !t.closest) return;
  var btn = t.closest('.btn');
  if (!btn || btn.disabled || btn.dataset.busy === '1') return;
  btn.classList.add('tap');
  setTimeout(function () { btn.classList.remove('tap'); }, 180);
}

$('btnCfg').onclick = function () { openSetup(true); };
$('btnBack').onclick = function () { if (configured()) closeSetup(); };

$('btnSetup').onclick = function () {
  if (this.dataset.busy === '1') return;
  var btn = this;
  var url = $('apiUrl').value.trim();
  var key = $('apiKey').value.trim();
  if (!url || !key) { showToast('請填網址與金鑰', true); return; }
  try {
    localStorage.setItem(URL_KEY, url);
    localStorage.setItem(KEY_KEY, key);
  } catch (e) {
    showToast('無法儲存', true);
    return;
  }
  var pending = readQueue();
  for (var i = 0; i < pending.length; i++) {
    pending[i].told = false;
    pending[i].tries = 0;
  }
  writeQueue(pending);
  closeSetup();
  var p;
  if (!booted) p = start();
  else {
    p = syncBoot(true);
    kickQueue();
  }
  armButton(btn, p, true);
};

$('btnDraft').onclick = function () {
  if (this.dataset.busy === '1') return;
  state.date = fromInputDate($('date').value);
  state.dayType = $('dayType').value;
  var d = draftObj();
  writeLocalDraft(d);
  if (serverTimer) clearTimeout(serverTimer);
  var id = enqueueDraft(d, true);
  armButton(this, watchItem(id), true);
};

$('btnAddEx').onclick = function () {
  state.exercises.push({
    name: '',
    principle: '',
    sets: [emptySet()],
    lastSets: [],
    progressNote: '',
    ambiguous: false
  });
  render();
  saveDraftSilent();
};

$('date').addEventListener('change', function () {
  state.date = fromInputDate($('date').value);
  saveDraftSilent();
});
$('dayType').addEventListener('change', function () {
  state.dayType = $('dayType').value;
  saveDraftSilent();
});

$('btnGenerate').onclick = function () {
  if (this.dataset.busy === '1') return;
  var btn = this;
  var dayType = $('dayType').value;
  setLoading(true);
  setNet('同步中');
  var p = api('generateSession', { dayType: dayType }).then(function (res) {
    setLoading(false);
    if (!readQueue().length) setNet('已同步');
    if (!res || !res.ok) {
      showToast((res && res.error) || '生成失敗', true);
      return { ok: false, error: (res && res.error) || '生成失敗' };
    }
    var s = res.session;
    state.dayType = s.dayType;
    state.date = s.date || fromInputDate($('date').value);
    state.sourceDate = s.sourceDate;
    state.notes = s.notes || [];
    if (s.plan) {
      state.notes = state.notes.concat([
        '將寫入：' + (s.plan.mode === 'newBlock' ? '新週期區塊 ' + s.plan.colLetter : '目前區塊往下接') +
        (s.plan.expectedNext && s.plan.expectedNext !== dayType
          ? '（依循環下一天應是「' + s.plan.expectedNext + '」，你選了「' + dayType + '」）'
          : '')
      ]);
    }
    state.exercises = (s.exercises || []).map(function (e) {
      return {
        name: e.name,
        principle: e.principle || '',
        sets: (e.sets || []).map(function (set) {
          return {
            weight: set.weight === null || set.weight === undefined ? '' : set.weight,
            reps: set.reps === null || set.reps === undefined ? '' : set.reps,
            sec: set.sec === null || set.sec === undefined ? '' : set.sec,
            rpe: '',
            rest: set.rest === null || set.rest === undefined ? '' : set.rest,
            principle: set.principle || '',
            feel: ''
          };
        }),
        lastSets: e.lastSets || [],
        progressNote: e.progressNote || '',
        ambiguous: !!e.ambiguous
      };
    });
    render();
    rememberPlan();
    saveDraftSilent();
    showToast('已生成「' + dayType + '」課表（模板 ' + (s.sourceDate || '') + '）');
    return { ok: true };
  }).catch(function (err) {
    setLoading(false);
    setNet('待重試');
    showToast(String(err && err.message || err), true);
    return { ok: false, error: String(err && err.message || err) };
  });
  armButton(btn, p, false);
};

var saveLock = false;
function doSave(overwrite) {
  if (saveLock) return;
  state.date = fromInputDate($('date').value);
  state.dayType = $('dayType').value;
  if (!state.date) { showToast('請填日期', true); return; }
  if (!state.exercises.length) { showToast('沒有動作可寫入', true); return; }
  saveLock = true;
  setTimeout(function () { saveLock = false; }, 800);

  var payload = {
    date: state.date,
    dayType: state.dayType,
    overwrite: !!overwrite,
    exercises: state.exercises.map(function (e) {
      return {
        name: e.name,
        principle: e.principle || '',
        sets: (e.sets || []).map(function (s) {
          return {
            weight: s.weight,
            reps: s.reps,
            sec: s.sec,
            rpe: s.rpe,
            rest: s.rest,
            principle: s.principle || '',
            feel: s.feel || ''
          };
        })
      };
    })
  };
  writeLocalDraft(draftObj());
  return enqueueSession(payload);
}

$('btnSave').onclick = function () {
  if (this.dataset.busy === '1') return;
  var id = doSave(false);
  if (!id) return;
  armButton(this, watchItem(id), true);
};

// iOS: after the keyboard closes, the viewport can stay shifted and leave a blank area.
// Nudging the scroll position makes WebKit recalc the layout.
(function () {
  function nudge() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    window.scrollTo(0, y + 1);
    window.scrollTo(0, y);
  }
  document.addEventListener('focusout', function (e) {
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      setTimeout(function () {
        var a = document.activeElement && document.activeElement.tagName;
        if (a !== 'INPUT' && a !== 'TEXTAREA' && a !== 'SELECT') nudge();
      }, 120);
    }
  });
  if (window.visualViewport) {
    var lastH = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', function () {
      var h = window.visualViewport.height;
      if (h > lastH + 80) setTimeout(nudge, 50);
      lastH = h;
    });
  }
})();

function scheduleBoot() {
  if (bootTimer) return;
  bootTimer = setTimeout(function () {
    bootTimer = null;
    syncBoot(true);
  }, 4000);
}

function syncBoot(silent) {
  if (!configured()) return Promise.resolve({ cancel: true });
  setNet('同步中');
  return api('bootstrap', null).then(function (res) {
    if (!res || res.ok === false) {
      if (!silent && !(state.exercises && state.exercises.length)) {
        showToast('初始化失敗：' + ((res && res.error) || ''), true);
      }
      setNet(res && res.error === '未授權' ? '未授權' : '待重試');
      if (!(res && res.error === '未授權')) scheduleBoot();
      return {
        ok: false,
        retry: !(res && res.error === '未授權'),
        error: (res && res.error) || '初始化失敗'
      };
    }
    try {
      localStorage.setItem(BOOT_KEY, JSON.stringify({
        today: res.today,
        nextDayType: res.nextDayType,
        cycleOrder: res.cycleOrder,
        lastDay: res.lastDay,
        blockCount: res.blockCount,
        savedAt: Date.now()
      }));
    } catch (e) {}
    fillTypes((res.cycleOrder && res.cycleOrder.length) ? res.cycleOrder : DEFAULT_ORDER);
    state.lastDay = res.lastDay || null;
    if (!dirty) {
      var emptyBefore = !(state.exercises && state.exercises.length);
      var local = readJSON(DRAFT_KEY);
      loadDraft(res.draft);
      if (emptyBefore && state.exercises.length && !silent) showToast('已還原草稿');
      else if (emptyBefore && !state.exercises.length) {
        state.dayType = res.nextDayType || state.dayType || '推';
        state.date = res.today || state.date;
        if (!silent) showToast('就緒：建議下一天「' + state.dayType + '」');
      } else if (res.draft && res.draft.exercises &&
          (!local || (res.draft.savedAt || 0) > (local.savedAt || 0))) {
        showToast('已還原草稿');
      }
      render();
    } else {
      var meta = [];
      if (state.lastDay) meta.push('上次訓練：' + state.lastDay.date + '（' + state.lastDay.dayType + '）');
      if (state.sourceDate) meta.push('模板來源：' + state.sourceDate);
      $('meta').textContent = meta.join(' · ');
    }
    if (!readQueue().length) setNet('已同步');
    return { ok: true };
  }).catch(function (err) {
    if (!silent && !(state.exercises && state.exercises.length)) {
      showToast('初始化失敗：' + (err && err.message || err), true);
    }
    setNet('待重試');
    scheduleBoot();
    return { ok: false, retry: true, error: String(err && err.message || err) };
  });
}

function start() {
  booted = true;
  var boot = readJSON(BOOT_KEY);
  fillTypes((boot && boot.cycleOrder) || DEFAULT_ORDER);
  if (boot) {
    state.lastDay = boot.lastDay || null;
    state.dayType = boot.nextDayType || '推';
    state.date = boot.today || '';
  }
  var restored = restoreLocal();
  render();
  if (restored) showToast('已還原草稿');
  var p = syncBoot(!!restored);
  kickQueue();
  return p;
}

document.addEventListener('touchstart', pressBtn, { passive: true });
document.addEventListener('pointerdown', function (e) {
  if (e.pointerType === 'touch') return;
  pressBtn(e);
});
window.addEventListener('online', function () { kickQueue(); });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') kickQueue();
});

if (configured()) start();
else openSetup(false);
