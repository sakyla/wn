var WL_SHEET_TITLE = '課表 v17';
var WL_FORBIDDEN = {
  '增肌減脂分析紀錄': true,
  'Training Review': true,
  '訓練原則': true
};

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WorkoutLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CYCLE_ORDER = ['推', '腿', '有氧', '拉', '補量'];
  var HEADERS = ['動作', '重量', '次數', '秒數', 'RPE', '組間 秒', '原則', '體感'];
  var BLOCK_WIDTH = 8;

  var WARMUP_NAMES = [
    '世界偉大伸展', '貓牛式', '熊爬支撐', '動態熊爬支撐'
  ];

  function isWarmupOrMobility(name) {
    if (!name) return true;
    var n = String(name);
    if (/時間：|坡度：|速度：/.test(n)) return true; 
    for (var i = 0; i < WARMUP_NAMES.length; i++) {
      if (n.indexOf(WARMUP_NAMES[i]) === 0 || n === WARMUP_NAMES[i]) return true;
    }
    
    return false;
  }

  function isNonProgressing(name) {
    if (!name) return true;
    var n = String(name);
    if (/時間：|坡度：|速度：/.test(n)) return true;
    if (
      n === '世界偉大伸展' ||
      n === '貓牛式' ||
      n === '熊爬支撐' ||
      n.indexOf('熊爬') !== -1
    ) {
      return true;
    }
    return false;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && !isNaN(v)) return v;
    var s = String(v).replace(/,/g, '').trim();
    if (!s) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function colToLetter(n) {
    var s = '';
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function letterToCol(s) {
    var n = 0;
    s = String(s).toUpperCase();
    for (var i = 0; i < s.length; i++) {
      n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n;
  }

  function nextDayType(current) {
    var idx = CYCLE_ORDER.indexOf(current);
    if (idx < 0) return '推';
    return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
  }

  function detectDayType(rows) {
    if (!rows || !rows.length) return null;
    var names = rows.map(function (r) { return String(r.name || ''); }).join('|');
    if (/時間：|坡度：/.test(names)) return '有氧';
    if (/自由槓深蹲|高腳杯深蹲/.test(names) && !/啞鈴臥推/.test(names)) return '腿';
    if (/啞鈴臥推|上斜臥推|機械夾胸/.test(names)) return '推';
    if (/滑輪下拉|坐姿划船|直臂下壓/.test(names)) return '拉';
    if (/側平舉|腿後勾/.test(names)) return '補量';
    return null;
  }

  function groupExercises(rows) {
    var groups = [];
    var cur = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var name = row.name || '';
      if (!cur || cur.name !== name) {
        cur = { name: name, sets: [], principle: '', feelNotes: [] };
        groups.push(cur);
      }
      cur.sets.push({
        weight: toNum(row.weight),
        reps: toNum(row.reps),
        sec: toNum(row.sec),
        rpe: toNum(row.rpe),
        rest: row.rest === '' || row.rest === null || row.rest === undefined ? '' : row.rest,
        principle: row.principle || '',
        feel: row.feel || ''
      });
      if (row.principle && !cur.principle) cur.principle = row.principle;
    }
    return groups;
  }

  function flattenExercises(exercises) {
    var rows = [];
    for (var i = 0; i < exercises.length; i++) {
      var ex = exercises[i];
      for (var j = 0; j < ex.sets.length; j++) {
        var s = ex.sets[j];
        rows.push({
          name: ex.name,
          weight: s.weight === null || s.weight === undefined ? '' : s.weight,
          reps: s.reps === null || s.reps === undefined ? '' : s.reps,
          sec: s.sec === null || s.sec === undefined ? '' : s.sec,
          rpe: s.rpe === null || s.rpe === undefined ? '' : s.rpe,
          rest: s.rest === null || s.rest === undefined ? '' : s.rest,
          principle: j === 0 ? (ex.principle || s.principle || '') : (s.principle || ''),
          feel: s.feel || ''
        });
      }
    }
    return rows;
  }

  
  function inferRepRange(historySetReps) {
    var all = [];
    var recent = historySetReps.length
      ? historySetReps[historySetReps.length - 1].filter(function (v) { return v !== null && v !== undefined; })
      : [];
    for (var i = 0; i < historySetReps.length; i++) {
      for (var j = 0; j < historySetReps[i].length; j++) {
        var v = historySetReps[i][j];
        if (v !== null && v !== undefined) all.push(v);
      }
    }
    if (!all.length) return { lo: 8, hi: 10, ambiguous: true };
    var rMin = recent.length ? Math.min.apply(null, recent) : Math.min.apply(null, all);
    var rMax = recent.length ? Math.max.apply(null, recent) : Math.max.apply(null, all);
    var windows = [
      [5, 8], [6, 8], [6, 10], [8, 10], [8, 12], [10, 12],
      [10, 15], [12, 15], [12, 17], [13, 15], [15, 17], [15, 20]
    ];
    var best = null;
    for (var w = 0; w < windows.length; w++) {
      var lo = windows[w][0];
      var hi = windows[w][1];
      if (rMin >= lo && rMax <= hi) {
        var score = (hi - lo) + Math.abs(lo - rMin) * 0.1;
        if (!best || score < best._score) {
          best = { lo: lo, hi: hi, source: 'window', _score: score };
        }
      }
    }
    if (best) {
      delete best._score;
      return best;
    }
    return { lo: rMin, hi: Math.max(rMax, rMin + 2), source: 'data', ambiguous: true };
  }

  
  function inferWeightIncrement(weightsChronological) {
    var jumps = [];
    var uniq = [];
    for (var i = 0; i < weightsChronological.length; i++) {
      var w = weightsChronological[i];
      if (w === null || w === undefined) continue;
      if (!uniq.length || uniq[uniq.length - 1] !== w) uniq.push(w);
    }
    for (var j = 1; j < uniq.length; j++) {
      var d = +(uniq[j] - uniq[j - 1]).toFixed(4);
      if (d > 0) jumps.push(d);
    }
    if (!jumps.length) {
      
      var last = uniq.length ? uniq[uniq.length - 1] : 20;
      if (last >= 60) return 2.5;
      if (last >= 40) return 2;
      if (last >= 20) return 2;
      return 1;
    }
    
    jumps.sort(function (a, b) { return a - b; });
    return jumps[Math.floor(jumps.length / 2)];
  }

  

  function progressSets(sets, repRange, weightInc) {
    var lo = repRange.lo;
    var hi = repRange.hi;
    var note = '';
    var ambiguous = !!repRange.ambiguous;

    var out = sets.map(function (s) {
      return {
        weight: s.weight,
        reps: s.reps,
        sec: s.sec,
        rpe: '',
        rest: s.rest,
        principle: s.principle || '',
        feel: ''
      };
    });

    if (!out.length) return { sets: out, note: '無組數', ambiguous: true };

    var workable = out.every(function (s) {
      return s.weight !== null && s.reps !== null;
    });
    if (!workable) {
      return { sets: out, note: '保留上次（資料不完整）', ambiguous: true };
    }

    var allAtHi = out.every(function (s) { return s.reps >= hi; });
    var allSameWeight = out.every(function (s) { return s.weight === out[0].weight; });

    if (allAtHi && allSameWeight) {
      var inc = weightInc || 2;
      var newW = +(out[out.length - 1].weight + inc).toFixed(2);
      out[out.length - 1].weight = newW;
      out[out.length - 1].reps = lo;
      note = '達 ' + hi + ' 全組 → 末組加重 +' + inc + ' 降回 ' + lo;
      return { sets: out, note: note, ambiguous: ambiguous };
    }

    if (!allSameWeight) {
      var maxW = Math.max.apply(null, out.map(function (s) { return s.weight; }));
      var minW = Math.min.apply(null, out.map(function (s) { return s.weight; }));
      var promoteIdx = -1;
      for (var i = out.length - 1; i >= 0; i--) {
        if (out[i].weight === minW) {
          promoteIdx = i;
          break;
        }
      }
      if (promoteIdx >= 0) {
        out[promoteIdx].weight = maxW;
        out[promoteIdx].reps = lo;
        note = '換重推進：第 ' + (promoteIdx + 1) + ' 組 → ' + maxW + '×' + lo;
        return { sets: out, note: note, ambiguous: ambiguous };
      }
    }

    
    
    var minReps = null;
    for (var k0 = 0; k0 < out.length; k0++) {
      if (out[k0].reps < hi) {
        if (minReps === null || out[k0].reps < minReps) minReps = out[k0].reps;
      }
    }
    var targetIdx = -1;
    if (minReps !== null) {
      for (var k = out.length - 1; k >= 0; k--) {
        if (out[k].reps === minReps) {
          targetIdx = k;
          break;
        }
      }
    }
    if (targetIdx >= 0) {
      out[targetIdx].reps = out[targetIdx].reps + 1;
      note = '雙重漸進加次：第 ' + (targetIdx + 1) + ' 組 → ' + out[targetIdx].reps;
      return { sets: out, note: note, ambiguous: ambiguous };
    }

    note = '已在區間頂，但重量結構無法判斷，保留上次';
    return { sets: out, note: note, ambiguous: true };
  }

  function collectExerciseHistory(cycles, exerciseName, dayType) {
    var hist = []; 
    for (var c = 0; c < cycles.length; c++) {
      var days = cycles[c].days || [];
      for (var d = 0; d < days.length; d++) {
        if (dayType && days[d].dayType && days[d].dayType !== dayType) continue;
        var groups = groupExercises(days[d].rows || []);
        for (var g = 0; g < groups.length; g++) {
          if (groups[g].name === exerciseName) {
            hist.push({
              date: days[d].date,
              sets: groups[g].sets,
              principle: groups[g].principle
            });
          }
        }
      }
    }
    return hist;
  }

  function generateNextSession(cycles, dayType) {
    
    var template = null;
    for (var c = cycles.length - 1; c >= 0; c--) {
      var days = cycles[c].days || [];
      for (var d = days.length - 1; d >= 0; d--) {
        if (days[d].dayType === dayType) {
          template = days[d];
          break;
        }
      }
      if (template) break;
    }
    if (!template) {
      return {
        dayType: dayType,
        date: '',
        exercises: [],
        sourceDate: null,
        notes: ['找不到此類型的歷史課表']
      };
    }

    var groups = groupExercises(template.rows || []);
    var exercises = [];
    var notes = [];

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var lastSets = g.sets.map(function (s) {
        return {
          weight: s.weight,
          reps: s.reps,
          sec: s.sec,
          rpe: s.rpe,
          rest: s.rest,
          principle: s.principle,
          feel: s.feel
        };
      });

      var targetSets;
      var progressNote = '';
      var ambiguous = false;

      if (dayType === '有氧' || isNonProgressing(g.name)) {
        targetSets = lastSets.map(function (s) {
          return {
            weight: s.weight,
            reps: s.reps,
            sec: s.sec,
            rpe: '',
            rest: s.rest,
            principle: s.principle,
            feel: ''
          };
        });
        progressNote = '照上次複製（熱身／有氧／核心不自動加）';
      } else {
        var hist = collectExerciseHistory(cycles, g.name, dayType);
        var repHist = hist.map(function (h) {
          return h.sets.map(function (s) { return s.reps; });
        });
        var weightHist = [];
        for (var h = 0; h < hist.length; h++) {
          for (var s = 0; s < hist[h].sets.length; s++) {
            if (hist[h].sets[s].weight !== null) weightHist.push(hist[h].sets[s].weight);
          }
        }
        var range = inferRepRange(repHist);
        var inc = inferWeightIncrement(weightHist);
        var flatHold = false;
        if (hist.length >= 3) {
          flatHold = true;
          var a = hist[hist.length - 1].sets;
          for (var fi = hist.length - 3; fi < hist.length - 1; fi++) {
            var b = hist[fi].sets;
            if (a.length !== b.length) { flatHold = false; break; }
            for (var fj = 0; fj < a.length; fj++) {
              if (a[fj].weight !== b[fj].weight || a[fj].reps !== b[fj].reps) {
                flatHold = false;
                break;
              }
            }
            if (!flatHold) break;
          }
        }
        var result;
        if (flatHold) {
          result = {
            sets: lastSets.map(function (s) {
              return {
                weight: s.weight, reps: s.reps, sec: s.sec, rpe: '',
                rest: s.rest, principle: s.principle, feel: ''
              };
            }),
            note: '近 3 次同內容，先持平（課尾／刻意不加重）',
            ambiguous: false
          };
        } else {
          result = progressSets(lastSets, range, inc);
        }
        targetSets = result.sets;
        progressNote = result.note +
          '（區間 ' + range.lo + '–' + range.hi + '，加重 ' + inc + '）';
        ambiguous = result.ambiguous;
      }

      exercises.push({
        name: g.name,
        principle: g.principle || '',
        sets: targetSets,
        lastSets: lastSets,
        progressNote: progressNote,
        ambiguous: ambiguous
      });
    }

    return {
      dayType: dayType,
      date: '',
      exercises: exercises,
      sourceDate: template.date,
      notes: notes
    };
  }

  function suggestNextDayType(cycles) {
    if (!cycles.length) return '推';
    var lastCycle = cycles[cycles.length - 1];
    var days = lastCycle.days || [];
    if (!days.length) return '推';
    var last = days[days.length - 1];
    return nextDayType(last.dayType);
  }

  

  function buildDayValues(dateStr, exercises, includeTopDate) {
    var rows = [];
    if (includeTopDate) {
      
      
    }
    
    var dateRow = ['', '', '', '', '', '', '', ''];
    dateRow[0] = dateStr;
    rows.push(dateRow);
    rows.push(HEADERS.slice());
    var flat = flattenExercises(exercises);
    for (var i = 0; i < flat.length; i++) {
      var f = flat[i];
      rows.push([
        f.name,
        f.weight,
        f.reps,
        f.sec,
        f.rpe,
        f.rest,
        f.principle,
        f.feel
      ]);
    }
    return { values: rows, rowCount: rows.length };
  }

  

  var DEFAULT_DAY_ROWS = { '推': 1, '腿': 27, '有氧': 51, '拉': 58, '補量': 82 };

  function planWrite(cycles, dayType) {
    var blankRowsBefore = 7;
    if (!cycles.length) {
      return {
        mode: 'newBlock',
        colStart: 1,
        formatFromCol: null,
        blankRowsBefore: 0,
        isFirstDayOfBlock: true
      };
    }
    var last = cycles[cycles.length - 1];
    var lastDays = last.days || [];
    var lastType = lastDays.length ? lastDays[lastDays.length - 1].dayType : null;
    var expected = lastType ? nextDayType(lastType) : '推';

    
    var startNew =
      dayType === '推' && (lastType === '補量' || lastType === null);

    
    
    
    if (startNew) {
      return {
        mode: 'newBlock',
        colStart: last.colEnd + 1,
        formatFromCol: last.colStart,
        blankRowsBefore: 0,
        isFirstDayOfBlock: true,
        expectedNext: expected
      };
    }

    
    
    
    var anchorRow = null;
    var formatFrom = null;
    for (var bi = cycles.length - 2; bi >= 0 && anchorRow === null; bi--) {
      var bd = cycles[bi].days || [];
      for (var di = 0; di < bd.length; di++) {
        if (bd[di].dayType === dayType && bd[di].dateRow) {
          anchorRow = bd[di].dateRow;
          formatFrom = cycles[bi].colStart;
          break;
        }
      }
    }
    if (anchorRow === null && DEFAULT_DAY_ROWS[dayType]) anchorRow = DEFAULT_DAY_ROWS[dayType];
    return {
      mode: 'append',
      colStart: last.colStart,
      formatFromCol: formatFrom,
      anchorRow: anchorRow,
      blankRowsBefore: blankRowsBefore,
      isFirstDayOfBlock: false,
      expectedNext: expected
    };
  }

  

  function parseBlock(grid, colStart) {
    var days = [];
    var i = 0;
    var startDate = null;

    function isHeaderRow(row) {
      return row && String(row[0] || '') === '動作' && String(row[1] || '') === '重量';
    }
    function isDateCell(v) {
      if (v === null || v === undefined || v === '') return false;
      if (Object.prototype.toString.call(v) === '[object Date]') return true;
      var s = String(v);
      return /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s) || /^\d{4}-\d{1,2}-\d{1,2}/.test(s);
    }
    function formatDate(v) {
      if (Object.prototype.toString.call(v) === '[object Date]') {
        var y = v.getFullYear();
        var m = v.getMonth() + 1;
        var d = v.getDate();
        return y + '/' + m + '/' + d;
      }
      return String(v).replace(/-/g, '/').replace(/\/0+/g, '/').replace(/^(\d{4})\/0?(\d+)\/0?(\d+)/, function (_, y, mo, da) {
        return y + '/' + parseInt(mo, 10) + '/' + parseInt(da, 10);
      });
    }
    function emptyRow(row) {
      if (!row) return true;
      for (var k = 0; k < BLOCK_WIDTH; k++) {
        if (row[k] !== null && row[k] !== undefined && String(row[k]).trim() !== '') return false;
      }
      return true;
    }

    while (i < grid.length) {
      while (i < grid.length && emptyRow(grid[i])) i++;
      if (i >= grid.length) break;

      var dateStr = null;
      var dateRowNum = i + 1;
      if (isDateCell(grid[i][0])) {
        dateStr = formatDate(grid[i][0]);
        if (!startDate) startDate = dateStr;
        i++;
      } else if (i === 0 && isDateCell(grid[0][0])) {
        dateStr = formatDate(grid[0][0]);
        startDate = dateStr;
        i++;
      } else {
        
        i++;
        continue;
      }

      if (i < grid.length && isHeaderRow(grid[i])) i++;

      var rows = [];
      while (i < grid.length && !emptyRow(grid[i]) && !isDateCell(grid[i][0]) && !isHeaderRow(grid[i])) {
        var row = grid[i];
        rows.push({
          name: row[0] === null || row[0] === undefined ? '' : String(row[0]),
          weight: row[1] === null || row[1] === undefined ? '' : row[1],
          reps: row[2] === null || row[2] === undefined ? '' : row[2],
          sec: row[3] === null || row[3] === undefined ? '' : row[3],
          rpe: row[4] === null || row[4] === undefined ? '' : row[4],
          rest: row[5] === null || row[5] === undefined ? '' : row[5],
          principle: row[6] === null || row[6] === undefined ? '' : String(row[6]),
          feel: row[7] === null || row[7] === undefined ? '' : String(row[7])
        });
        i++;
      }
      if (dateStr) {
        days.push({
          date: dateStr,
          dayType: detectDayType(rows) || '未知',
          dateRow: dateRowNum,
          rows: rows
        });
      }
    }

    return {
      startDate: startDate,
      colStart: colStart || null,
      colEnd: colStart ? colStart + BLOCK_WIDTH - 1 : null,
      days: days
    };
  }

  

  function findBlockStarts(row1) {
    var starts = [];
    for (var i = 0; i < row1.length; i++) {
      var v = row1[i];
      if (v === null || v === undefined || v === '') continue;
      var s = String(v);
      if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s) || Object.prototype.toString.call(v) === '[object Date]') {
        
        var col = i + 1; 
        var offset = (col - 1) % BLOCK_WIDTH;
        var start = col - offset;
        if (starts.indexOf(start) === -1) starts.push(start);
      }
    }
    return starts;
  }

  function sessionToWriteRows(session) {
    
    return flattenExercises(session.exercises.map(function (ex) {
      return {
        name: ex.name,
        principle: ex.principle || '',
        sets: ex.sets
      };
    }));
  }

  return {
    CYCLE_ORDER: CYCLE_ORDER,
    HEADERS: HEADERS,
    BLOCK_WIDTH: BLOCK_WIDTH,
    toNum: toNum,
    colToLetter: colToLetter,
    letterToCol: letterToCol,
    nextDayType: nextDayType,
    detectDayType: detectDayType,
    groupExercises: groupExercises,
    flattenExercises: flattenExercises,
    inferRepRange: inferRepRange,
    inferWeightIncrement: inferWeightIncrement,
    progressSets: progressSets,
    collectExerciseHistory: collectExerciseHistory,
    generateNextSession: generateNextSession,
    suggestNextDayType: suggestNextDayType,
    buildDayValues: buildDayValues,
    planWrite: planWrite,
    parseBlock: parseBlock,
    findBlockStarts: findBlockStarts,
    sessionToWriteRows: sessionToWriteRows,
    isNonProgressing: isNonProgressing
  };
});

var WorkoutLogic = (typeof WorkoutLogic !== 'undefined')
  ? WorkoutLogic
  : (typeof globalThis !== 'undefined' && globalThis.WorkoutLogic)
    ? globalThis.WorkoutLogic
    : null;
if (!WorkoutLogic) {
  throw new Error('WorkoutLogic failed to load');
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (!params.action) return wl_legacyPage_();
  return wl_dispatch_(wl_fromParams_(params));
}

function doPost(e) {
  return wl_dispatch_(wl_fromPost_(e));
}

function wl_legacyPage_() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('訓練紀錄')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function wl_fromPost_(e) {
  var raw = '';
  if (e && e.postData && e.postData.contents) raw = String(e.postData.contents);
  raw = raw.replace(/^\uFEFF/, '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function wl_fromParams_(p) {
  var payload = p.payload;
  if (typeof payload === 'string' && payload) {
    try { payload = JSON.parse(payload); } catch (err) {}
  }
  if ((payload === undefined || payload === '') && p.dayType) payload = p.dayType;
  return { key: p.key, action: p.action, payload: payload };
}

function wl_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.TEXT);
}

function wl_keyOk_(key) {
  var want = PropertiesService.getScriptProperties().getProperty('WL_API_KEY') || '';
  var got = key === undefined || key === null ? '' : String(key);
  if (!want || got.length !== want.length) return false;
  var diff = 0;
  for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function wl_dispatch_(req) {
  try {
    if (!req || !wl_keyOk_(req.key)) return wl_json_({ ok: false, error: '未授權' });
    var action = String(req.action || '');
    var payload = req.payload;
    var out;
    if (action === 'bootstrap') out = wl_getBootstrap();
    else if (action === 'saveDraft') {
      out = wl_saveDraft(typeof payload === 'string' ? payload : JSON.stringify(payload == null ? null : payload));
    } else if (action === 'clearDraft') out = wl_clearDraft();
    else if (action === 'generateSession') {
      var dayType = payload;
      if (payload && typeof payload === 'object') dayType = payload.dayType;
      out = wl_generateSession(dayType);
    } else if (action === 'saveSession') out = wl_saveSession(payload);
    else out = { ok: false, error: '未知操作' };
    return wl_json_(out == null ? { ok: false } : out);
  } catch (err) {
    return wl_json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function wl_initApiKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('WL_API_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('WL_API_KEY', key);
  }
  Logger.log(key);
}

function wl_getBootstrap() {
  var cycles = wl_loadCycles_();
  var nextType = WorkoutLogic.suggestNextDayType(cycles);
  var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  var now = Utilities.formatDate(new Date(), tz, 'yyyy/M/d');
  var lastDay = null;
  if (cycles.length) {
    var days = cycles[cycles.length - 1].days || [];
    if (days.length) lastDay = { date: days[days.length - 1].date, dayType: days[days.length - 1].dayType };
  }
  return {
    ok: true,
    today: now,
    nextDayType: nextType,
    cycleOrder: WorkoutLogic.CYCLE_ORDER,
    lastDay: lastDay,
    blockCount: cycles.length,
    draft: wl_loadDraft()
  };
}

var WL_DRAFT_PREFIX = 'wl_draft_chunk_';
var WL_DRAFT_COUNT = 'wl_draft_count';
var WL_DRAFT_CHUNK = 8000;

function wl_saveDraft(json) {
  if (typeof json !== 'string') json = JSON.stringify(json || null);
  var props = PropertiesService.getUserProperties();
  wl_clearDraft();
  var n = Math.ceil(json.length / WL_DRAFT_CHUNK) || 1;
  var data = {};
  for (var i = 0; i < n; i++) {
    data[WL_DRAFT_PREFIX + i] = json.substr(i * WL_DRAFT_CHUNK, WL_DRAFT_CHUNK);
  }
  data[WL_DRAFT_COUNT] = String(n);
  props.setProperties(data, false);
  return { ok: true };
}

function wl_loadDraft() {
  var props = PropertiesService.getUserProperties();
  var n = parseInt(props.getProperty(WL_DRAFT_COUNT) || '0', 10);
  if (!n) return null;
  var parts = [];
  for (var i = 0; i < n; i++) parts.push(props.getProperty(WL_DRAFT_PREFIX + i) || '');
  try { return JSON.parse(parts.join('')); } catch (e) { return null; }
}

function wl_clearDraft() {
  var props = PropertiesService.getUserProperties();
  var n = parseInt(props.getProperty(WL_DRAFT_COUNT) || '0', 10);
  for (var i = 0; i < n; i++) props.deleteProperty(WL_DRAFT_PREFIX + i);
  props.deleteProperty(WL_DRAFT_COUNT);
  return { ok: true };
}

function wl_generateSession(dayType) {
  dayType = dayType || '推';
  var cycles = wl_loadCycles_();
  var session = WorkoutLogic.generateNextSession(cycles, dayType);
  var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  session.date = Utilities.formatDate(new Date(), tz, 'yyyy/M/d');
  session.plan = WorkoutLogic.planWrite(cycles, dayType);
  session.plan.colLetter = WorkoutLogic.colToLetter(session.plan.colStart);
  return { ok: true, session: session };
}

function wl_saveSession(payload) {
  if (!payload || !payload.date || !payload.dayType || !payload.exercises) {
    return { ok: false, error: '缺少日期、日類型或動作資料' };
  }
  
  payload.exercises.forEach(function (ex) {
    if (ex && typeof ex.name === 'string' && /時間：/.test(ex.name)) {
      ex.name = ex.name
        .replace(/\s*(坡度：|速度：|心率：)/g, '\n$1')
        .replace(/\n+/g, '\n')
        .replace(/^\n/, '');
    }
  });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WL_SHEET_TITLE);
  if (!sheet) return { ok: false, error: '找不到分頁「' + WL_SHEET_TITLE + '」' };
  if (WL_FORBIDDEN[sheet.getName()]) {
    return { ok: false, error: '禁止寫入此分頁' };
  }

  
  var cycles = wl_loadCycles_();
  var existing = wl_findDayByDate_(cycles, payload.date);
  if (existing && !payload.overwrite) {
    return {
      ok: false,
      needConfirm: true,
      error: '日期 ' + payload.date + ' 已有紀錄（' + existing.dayType + '）。要覆蓋該日嗎？',
      existing: existing
    };
  }

  if (existing && payload.overwrite) {
    return wl_overwriteDay_(sheet, cycles, existing, payload);
  }

  var plan = WorkoutLogic.planWrite(cycles, payload.dayType);
  var built = WorkoutLogic.buildDayValues(payload.date, payload.exercises, true);

  if (plan.mode === 'newBlock') {
    return wl_writeNewBlock_(sheet, plan, built, payload.date);
  }
  return wl_appendDay_(sheet, plan, built, cycles);
}

function wl_findDayByDate_(cycles, dateStr) {
  var norm = String(dateStr).replace(/-/g, '/');
  for (var c = 0; c < cycles.length; c++) {
    var days = cycles[c].days || [];
    for (var d = 0; d < days.length; d++) {
      if (String(days[d].date).replace(/-/g, '/') === norm) {
        return {
          date: days[d].date,
          dayType: days[d].dayType,
          colStart: cycles[c].colStart,
          cycleIndex: c,
          dayIndex: d
        };
      }
    }
  }
  return null;
}

function wl_loadCycles_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WL_SHEET_TITLE);
  if (!sheet) return [];

  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  var row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var starts = WorkoutLogic.findBlockStarts(row1);
  
  if (!starts.length) {
    
    for (var c = 1; c <= lastCol; c += WorkoutLogic.BLOCK_WIDTH) {
      var a = sheet.getRange(1, c).getValue();
      var b = sheet.getRange(2, c).getValue();
      if (a || b) starts.push(c);
    }
  }

  var lastRow = Math.max(sheet.getLastRow(), 2);
  var cycles = [];
  for (var i = 0; i < starts.length; i++) {
    var colStart = starts[i];
    var grid = sheet.getRange(1, colStart, lastRow, WorkoutLogic.BLOCK_WIDTH).getValues();
    var block = WorkoutLogic.parseBlock(grid, colStart);
    block.colEnd = colStart + WorkoutLogic.BLOCK_WIDTH - 1;
    if (block.days && block.days.length) cycles.push(block);
  }
  return cycles;
}

function wl_writeNewBlock_(sheet, plan, built, dateStr) {
  var colStart = plan.colStart;
  var needCols = colStart + WorkoutLogic.BLOCK_WIDTH - 1;
  if (sheet.getMaxColumns() < needCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols - sheet.getMaxColumns());
  }

  
  if (plan.formatFromCol) {
    var src = sheet.getRange(1, plan.formatFromCol, Math.max(sheet.getLastRow(), built.rowCount + 5), WorkoutLogic.BLOCK_WIDTH);
    var dst = sheet.getRange(1, colStart, Math.max(sheet.getLastRow(), built.rowCount + 5), WorkoutLogic.BLOCK_WIDTH);
    src.copyTo(dst, { formatOnly: true });
  }

  
  var clearRows = Math.max(built.rowCount + 2, 30);
  sheet.getRange(1, colStart, clearRows, WorkoutLogic.BLOCK_WIDTH).clearContent();

  
  
  
  
  
  var values = built.values;
  
  sheet.getRange(1, colStart, values.length, WorkoutLogic.BLOCK_WIDTH).setValues(values);

  var endCol = colStart + WorkoutLogic.BLOCK_WIDTH - 1;
  var rangeA1 = WorkoutLogic.colToLetter(colStart) + '1:' + WorkoutLogic.colToLetter(endCol) + values.length;
  return {
    ok: true,
    mode: 'newBlock',
    range: "'" + WL_SHEET_TITLE + "'!" + rangeA1,
    colStart: colStart,
    rows: values.length
  };
}

function wl_appendDay_(sheet, plan, built, cycles) {
  var colStart = plan.colStart;
  var lastRow = sheet.getLastRow();
  
  var blockData = sheet.getRange(1, colStart, Math.max(lastRow, 1), WorkoutLogic.BLOCK_WIDTH).getValues();
  var lastUsed = 0;
  for (var r = 0; r < blockData.length; r++) {
    for (var c = 0; c < WorkoutLogic.BLOCK_WIDTH; c++) {
      if (blockData[r][c] !== '' && blockData[r][c] !== null) {
        lastUsed = r + 1; 
      }
    }
  }
  var fallbackRow = lastUsed + 1 + (plan.blankRowsBefore || 0);
  var startRow = fallbackRow;
  if (plan.anchorRow && plan.anchorRow > lastUsed) {
    
    var clear = true;
    for (var rr = plan.anchorRow - 1; rr < Math.min(blockData.length, plan.anchorRow - 1 + built.rowCount); rr++) {
      for (var cc = 0; cc < WorkoutLogic.BLOCK_WIDTH; cc++) {
        if (blockData[rr][cc] !== '' && blockData[rr][cc] !== null) { clear = false; break; }
      }
      if (!clear) break;
    }
    if (clear) startRow = plan.anchorRow;
  }
  
  if (plan.formatFromCol) {
    try {
      var fmtSrc = sheet.getRange(startRow, plan.formatFromCol, built.rowCount, WorkoutLogic.BLOCK_WIDTH);
      var fmtDst = sheet.getRange(startRow, colStart, built.rowCount, WorkoutLogic.BLOCK_WIDTH);
      fmtSrc.copyTo(fmtDst, { formatOnly: true });
    } catch (e) {
      
    }
  }

  var needRows = startRow + built.rowCount - 1;
  if (sheet.getMaxRows() < needRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  }

  sheet.getRange(startRow, colStart, built.rowCount, WorkoutLogic.BLOCK_WIDTH).setValues(built.values);

  var endCol = colStart + WorkoutLogic.BLOCK_WIDTH - 1;
  var rangeA1 =
    WorkoutLogic.colToLetter(colStart) + startRow + ':' +
    WorkoutLogic.colToLetter(endCol) + (startRow + built.rowCount - 1);
  return {
    ok: true,
    mode: 'append',
    range: "'" + WL_SHEET_TITLE + "'!" + rangeA1,
    colStart: colStart,
    startRow: startRow,
    rows: built.rowCount
  };
}

function wl_overwriteDay_(sheet, cycles, existing, payload) {
  var colStart = existing.colStart;
  var cycle = cycles[existing.cycleIndex];
  var lastRow = sheet.getLastRow();
  var grid = sheet.getRange(1, colStart, lastRow, WorkoutLogic.BLOCK_WIDTH).getValues();

  
  var dayStart = -1;
  var dateNorm = String(payload.date).replace(/-/g, '/');
  for (var i = 0; i < grid.length; i++) {
    var v = grid[i][0];
    var s = '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      s = v.getFullYear() + '/' + (v.getMonth() + 1) + '/' + v.getDate();
    } else {
      s = String(v || '').replace(/-/g, '/');
    }
    
    s = s.replace(/\/0+/g, '/');
    var target = dateNorm.replace(/\/0+/g, '/');
    
    if (s === dateNorm || s === target || wl_datesEqual_(s, dateNorm)) {
      dayStart = i;
      break;
    }
  }
  if (dayStart < 0) {
    return { ok: false, error: '找不到要覆蓋的日期列' };
  }

  
  var dayEnd = grid.length; 
  for (var j = dayStart + 1; j < grid.length; j++) {
    var v2 = grid[j][0];
    if (Object.prototype.toString.call(v2) === '[object Date]') {
      dayEnd = j;
      break;
    }
    var s2 = String(v2 || '');
    if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(s2)) {
      dayEnd = j;
      break;
    }
  }
  
  while (dayEnd > dayStart + 1) {
    var empty = true;
    var row = grid[dayEnd - 1];
    for (var c = 0; c < WorkoutLogic.BLOCK_WIDTH; c++) {
      if (row[c] !== '' && row[c] !== null) { empty = false; break; }
    }
    if (!empty) break;
    dayEnd--;
  }

  var built = WorkoutLogic.buildDayValues(payload.date, payload.exercises, true);
  var oldLen = dayEnd - dayStart;
  var newLen = built.rowCount;
  var writeStart = dayStart + 1; 

  
  sheet.getRange(writeStart, colStart, oldLen, WorkoutLogic.BLOCK_WIDTH).clearContent();

  if (newLen > oldLen) {
    
    sheet.insertRowsAfter(writeStart + oldLen - 1, newLen - oldLen);
  }

  sheet.getRange(writeStart, colStart, newLen, WorkoutLogic.BLOCK_WIDTH).setValues(built.values);

  
  var endCol = colStart + WorkoutLogic.BLOCK_WIDTH - 1;
  var rangeA1 =
    WorkoutLogic.colToLetter(colStart) + writeStart + ':' +
    WorkoutLogic.colToLetter(endCol) + (writeStart + newLen - 1);
  return {
    ok: true,
    mode: 'overwrite',
    range: "'" + WL_SHEET_TITLE + "'!" + rangeA1,
    colStart: colStart,
    startRow: writeStart,
    rows: newLen
  };
}

function wl_datesEqual_(a, b) {
  function parts(s) {
    var m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  }
  var pa = parts(a);
  var pb = parts(b);
  if (!pa || !pb) return false;
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}
