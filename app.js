// app.js — 画面の動き。データの出し入れは必ず db.js(window.DB)を経由する
(function () {
  'use strict';

  const TYPE_LABELS = { weight_reps: '重さ×回数', reps: '回数のみ', time: '時間のみ' };

  const state = {
    exercises: [],     // 表示中の種目
    selectedId: null,  // 選んでいる種目ID
    rows: [],          // 入力中のセット [{ weight, reps, seconds }](値は文字列)
    lastDate: null,    // 前回の日付
    saving: false,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    date: $('date'),
    exerciseList: $('exercise-list'),
    exerciseEmpty: $('exercise-empty'),
    entry: $('entry'),
    entryName: $('entry-name'),
    entryMeta: $('entry-meta'),
    setList: $('set-list'),
    addSet: $('add-set'),
    entryError: $('entry-error'),
    saveBar: $('save-bar'),
    save: $('save'),
    toast: $('toast'),
  };

  // ---------- 共通 ----------

  let toastTimer = null;
  function showToast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-shown'), 2000);
  }

  function showError(message) {
    el.entryError.textContent = message || '';
    el.entryError.hidden = !message;
  }

  function selectedExercise() {
    return state.exercises.find((e) => e.id === state.selectedId) || null;
  }

  function formatShortDate(ymd) {
    const [, m, d] = ymd.split('-').map(Number);
    return m + '/' + d;
  }

  // ---------- 種目ボタン ----------

  async function loadExercises() {
    const r = await DB.getExercises();
    state.exercises = r.ok ? r.exercises : [];
    if (!r.ok) showToast(r.message);
    if (state.selectedId && !selectedExercise()) state.selectedId = null;
    renderExercises();
  }

  function renderExercises() {
    el.exerciseList.textContent = '';
    state.exercises.forEach((ex) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (ex.id === state.selectedId ? ' is-selected' : '');
      b.textContent = ex.name;
      b.setAttribute('aria-pressed', ex.id === state.selectedId ? 'true' : 'false');
      b.setAttribute('aria-description', '長押しでメニュー');
      attachLongPress(b, () => openMenu(ex.id), () => selectExercise(ex.id));
      el.exerciseList.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip chip-add';
    add.textContent = '＋追加';
    add.addEventListener('click', openAddSheet);
    el.exerciseList.appendChild(add);
    el.exerciseEmpty.hidden = state.exercises.length > 0;
  }

  // 長押し(0.5秒)で onLong、普通のタップで onTap。PCでは右クリックでも onLong
  function attachLongPress(button, onLong, onTap) {
    const LONG_MS = 500;
    const MOVE_PX = 10;
    let timer = null;
    let startX = 0, startY = 0;
    let longFired = false;

    function cancel() {
      clearTimeout(timer);
      timer = null;
      button.classList.remove('is-pressing');
    }

    button.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      longFired = false;
      startX = e.clientX; startY = e.clientY;
      button.classList.add('is-pressing');
      timer = setTimeout(() => {
        longFired = true;
        cancel();
        if (navigator.vibrate) navigator.vibrate(10);
        onLong();
      }, LONG_MS);
    });
    button.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - startX) > MOVE_PX || Math.abs(e.clientY - startY) > MOVE_PX)) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => button.addEventListener(t, cancel));
    button.addEventListener('click', (e) => {
      if (longFired) { e.preventDefault(); longFired = false; return; }
      onTap();
    });
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!longFired) { cancel(); longFired = true; onLong(); }
    });
  }

  // ---------- シート共通 ----------

  function openSheet(sheet) {
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
  }

  function closeSheet(sheet) {
    sheet.hidden = true;
    if (document.querySelectorAll('.sheet:not([hidden])').length === 0) {
      document.body.classList.remove('sheet-open');
    }
  }

  document.querySelectorAll('.sheet').forEach((sheet) => {
    sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(sheet)));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.sheet:not([hidden])').forEach(closeSheet);
  });

  function setSheetError(target, message) {
    target.textContent = message || '';
    target.hidden = !message;
  }

  // ---------- 種目追加シート(5章) ----------

  const addEl = {
    sheet: $('add-sheet'),
    form: $('add-form'),
    name: $('add-name'),
    error: $('add-error'),
    submit: $('add-submit'),
  };

  function openAddSheet() {
    addEl.form.reset();
    setSheetError(addEl.error, '');
    openSheet(addEl.sheet);
    addEl.name.focus();
  }

  addEl.name.addEventListener('input', () => setSheetError(addEl.error, ''));

  addEl.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (addEl.submit.disabled) return;
    const name = addEl.name.value;
    const type = addEl.form.querySelector('input[name="add-type"]:checked').value;
    if (!name.trim()) {
      setSheetError(addEl.error, '種目名を入力してください');
      addEl.name.focus();
      return;
    }

    addEl.submit.disabled = true;
    try {
      const r = await DB.addExercise(name, type);
      if (r.ok) {
        closeSheet(addEl.sheet);
        await loadExercises();
        await selectExercise(r.exerciseId);
        showToast('「' + r.exercise.name + '」を追加しました');
        return;
      }
      if (r.error === 'duplicate') {
        // 同じ名前があれば追加せず、その種目を開く
        closeSheet(addEl.sheet);
        await selectExercise(r.exerciseId);
        showToast(r.message);
        return;
      }
      if (r.error === 'duplicate_hidden') {
        if (!window.confirm(r.message)) return;
        const u = await DB.updateExercise(r.exerciseId, { visible: true });
        if (!u.ok) { setSheetError(addEl.error, u.message); return; }
        closeSheet(addEl.sheet);
        await loadExercises();
        await selectExercise(r.exerciseId);
        showToast('「' + u.exercise.name + '」を再表示しました');
        return;
      }
      setSheetError(addEl.error, r.message);
    } finally {
      addEl.submit.disabled = false;
    }
  });

  // ---------- 種目メニュー(長押し): 名前変更・非表示・削除 ----------

  const menuEl = {
    sheet: $('menu-sheet'),
    form: $('rename-form'),
    title: $('menu-title'),
    meta: $('menu-meta'),
    rename: $('rename-input'),
    renameSubmit: $('rename-submit'),
    error: $('menu-error'),
    hide: $('hide-btn'),
    del: $('delete-btn'),
    deleteNote: $('delete-note'),
  };
  let menuExerciseId = null;

  async function openMenu(id) {
    const ex = state.exercises.find((e) => e.id === id);
    if (!ex) return;
    menuExerciseId = id;
    menuEl.title.textContent = ex.name;
    menuEl.meta.textContent = TYPE_LABELS[ex.type];
    menuEl.rename.value = ex.name;
    setSheetError(menuEl.error, '');
    menuEl.del.hidden = true;
    menuEl.deleteNote.hidden = true;
    openSheet(menuEl.sheet);

    // 記録がゼロの種目だけ削除ボタンを出す
    const last = await DB.getLastWorkout(id);
    if (menuExerciseId !== id) return;
    const hasRecords = !last.ok || last.date !== null;
    menuEl.del.hidden = hasRecords;
    menuEl.deleteNote.hidden = !hasRecords;
  }

  menuEl.rename.addEventListener('input', () => setSheetError(menuEl.error, ''));

  menuEl.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (menuEl.renameSubmit.disabled) return;
    menuEl.renameSubmit.disabled = true;
    try {
      const r = await DB.updateExercise(menuExerciseId, { name: menuEl.rename.value });
      if (!r.ok) { setSheetError(menuEl.error, r.message); return; }
      closeSheet(menuEl.sheet);
      await loadExercises();
      renderEntry();
      showToast('名前を変更しました');
    } finally {
      menuEl.renameSubmit.disabled = false;
    }
  });

  menuEl.hide.addEventListener('click', async () => {
    const r = await DB.updateExercise(menuExerciseId, { visible: false });
    if (!r.ok) { setSheetError(menuEl.error, r.message); return; }
    closeSheet(menuEl.sheet);
    await loadExercises();   // 選択中の種目を隠した場合は選択も外れる
    renderEntry();
    showToast('「' + r.exercise.name + '」を非表示にしました');
  });

  menuEl.del.addEventListener('click', async () => {
    const ex = state.exercises.find((e) => e.id === menuExerciseId);
    if (!ex || !window.confirm('「' + ex.name + '」を削除します。よろしいですか?')) return;
    const r = await DB.deleteExercise(menuExerciseId);
    if (!r.ok) { setSheetError(menuEl.error, r.message); return; }
    closeSheet(menuEl.sheet);
    await loadExercises();
    renderEntry();
    showToast('「' + ex.name + '」を削除しました');
  });

  // ---------- 入力欄 ----------

  function emptyRow() { return { weight: '', reps: '', seconds: '' }; }

  function toRow(set) {
    return {
      weight: set.weight != null ? String(set.weight) : '',
      reps: set.reps != null ? String(set.reps) : '',
      seconds: set.seconds != null ? String(set.seconds) : '',
    };
  }

  // 前回のセットを入力欄に入れる
  async function loadLastWorkout() {
    const r = await DB.getLastWorkout(state.selectedId);
    if (r.ok && r.sets.length > 0) {
      state.rows = r.sets.map(toRow);
      state.lastDate = r.date;
    } else {
      state.rows = [emptyRow()];
      state.lastDate = null;
    }
  }

  async function selectExercise(id) {
    state.selectedId = id;
    showError('');
    renderExercises();
    await loadLastWorkout();
    renderEntry();
  }

  function makeField(row, key, unit, inputmode, label) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = inputmode;
    input.autocomplete = 'off';
    input.value = row[key];
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => { row[key] = input.value; });
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = unit;
    wrap.append(input, u);
    return wrap;
  }

  function renderEntry() {
    const ex = selectedExercise();
    el.entry.hidden = !ex;
    el.saveBar.hidden = !ex;
    if (!ex) return;

    el.entryName.textContent = ex.name;
    el.entryMeta.textContent = TYPE_LABELS[ex.type] +
      (state.lastDate ? ' ・ 前回 ' + formatShortDate(state.lastDate) : ' ・ 初めての記録');

    el.setList.textContent = '';
    state.rows.forEach((row, i) => {
      const li = document.createElement('li');
      li.className = 'set-row';

      const no = document.createElement('span');
      no.className = 'set-no';
      no.textContent = i + 1;

      const fields = document.createElement('div');
      fields.className = 'set-fields';
      const n = (i + 1) + 'セット目の';
      if (ex.type === 'weight_reps') {
        const times = document.createElement('span');
        times.className = 'times';
        times.textContent = '×';
        fields.append(
          makeField(row, 'weight', 'kg', 'decimal', n + '重さ'),
          times,
          makeField(row, 'reps', '回', 'numeric', n + '回数'));
      } else if (ex.type === 'reps') {
        fields.append(makeField(row, 'reps', '回', 'numeric', n + '回数'));
      } else {
        fields.append(makeField(row, 'seconds', '秒', 'numeric', n + '秒数'));
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-remove';
      del.textContent = '×';
      del.setAttribute('aria-label', (i + 1) + 'セット目を削除');
      del.disabled = state.rows.length <= 1;
      del.addEventListener('click', () => {
        state.rows.splice(i, 1);
        renderEntry();
      });

      li.append(no, fields, del);
      el.setList.appendChild(li);
    });
  }

  el.addSet.addEventListener('click', () => {
    // 直前のセットの値を引き継いだ行を足す(同じ重さで続けることが多いため)
    const last = state.rows[state.rows.length - 1];
    state.rows.push(last ? Object.assign({}, last) : emptyRow());
    renderEntry();
    const inputs = el.setList.querySelectorAll('.set-row:last-child input');
    if (inputs[0]) inputs[0].focus();
  });

  // ---------- 保存 ----------

  el.save.addEventListener('click', async () => {
    const ex = selectedExercise();
    if (!ex || state.saving) return;
    state.saving = true;
    el.save.disabled = true;
    el.save.textContent = '保存中…';
    showError('');
    try {
      const r = await DB.addWorkout(el.date.value, ex.id, state.rows);
      if (!r.ok) { showError(r.message); return; }
      await loadLastWorkout();
      renderEntry();
      showToast('保存しました');
    } finally {
      state.saving = false;
      el.save.disabled = false;
      el.save.textContent = '保存';
    }
  });

  // ---------- グラフ画面(4章 画面2) ----------

  const UNITS = { weight_reps: 'kg', reps: '回', time: '秒' };
  const VALUE_LABELS = {
    weight_reps: '1日の「重さ×回数」の合計',
    reps: '1日の回数の合計',
    time: '1日の秒数の合計',
  };
  const DAY_MS = 24 * 60 * 60 * 1000;

  const graph = {
    exercises: [],       // 非表示も含めたすべての種目(過去の記録を見られるように)
    exerciseId: null,
    period: '3m',
    chart: null,
  };

  const gEl = {
    list: $('graph-exercise-list'),
    noExercise: $('graph-no-exercise'),
    body: $('graph-body'),
    name: $('graph-name'),
    meta: $('graph-meta'),
    best: $('stat-best'),
    bestDate: $('stat-best-date'),
    change: $('stat-change'),
    empty: $('graph-empty'),
    canvas: $('chart'),
  };

  function fmtNum(v) {
    return v.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
  }

  function ymdToTime(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  function timeToShort(t) {
    const d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  async function refreshGraph() {
    const r = await DB.getExercises({ all: true });
    const all = r.ok ? r.exercises : [];
    // 表示中の種目を先に、非表示の種目を後ろに並べる
    graph.exercises = all.filter((e) => e.visible).concat(all.filter((e) => !e.visible));
    if (!graph.exercises.some((e) => e.id === graph.exerciseId)) {
      const fromRecord = graph.exercises.find((e) => e.id === state.selectedId);
      graph.exerciseId = fromRecord ? fromRecord.id : (graph.exercises[0] ? graph.exercises[0].id : null);
    }
    renderGraphExercises();
    await renderGraph();
  }

  function renderGraphExercises() {
    gEl.list.textContent = '';
    graph.exercises.forEach((ex) => {
      const b = document.createElement('button');
      b.type = 'button';
      const selected = ex.id === graph.exerciseId;
      b.className = 'chip' + (selected ? ' is-selected' : '') + (ex.visible ? '' : ' is-hidden-exercise');
      b.textContent = ex.name;
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
      if (!ex.visible) b.title = '非表示の種目';
      b.addEventListener('click', async () => {
        graph.exerciseId = ex.id;
        renderGraphExercises();
        await renderGraph();
      });
      gEl.list.appendChild(b);
    });
    gEl.noExercise.hidden = graph.exercises.length > 0;
  }

  async function renderGraph() {
    const ex = graph.exercises.find((e) => e.id === graph.exerciseId);
    gEl.body.hidden = !ex;
    if (!ex) return;

    gEl.name.textContent = ex.name + (ex.visible ? '' : '(非表示)');
    gEl.meta.textContent = VALUE_LABELS[ex.type] + '(' + UNITS[ex.type] + ')';

    const r = await DB.getProgress(ex.id, graph.period);
    if (graph.exerciseId !== ex.id) return; // 待っている間に別の種目が選ばれた
    if (!r.ok) { showToast(r.message); return; }
    const unit = UNITS[ex.type];

    // 自己ベストと直近の伸び(全期間で計算)
    if (r.best) {
      gEl.best.textContent = fmtNum(r.best.value) + ' ' + unit;
      gEl.bestDate.textContent = timeToShort(ymdToTime(r.best.date)) + ' に達成';
    } else {
      gEl.best.textContent = '—';
      gEl.bestDate.textContent = '';
    }
    gEl.change.classList.remove('is-up', 'is-down');
    if (r.recentChange === null) {
      gEl.change.textContent = '—';
    } else {
      const sign = r.recentChange > 0 ? '+' : r.recentChange < 0 ? '−' : '±';
      gEl.change.textContent = sign + fmtNum(Math.abs(r.recentChange)) + ' ' + unit;
      if (r.recentChange > 0) gEl.change.classList.add('is-up');
      if (r.recentChange < 0) gEl.change.classList.add('is-down');
    }

    // 記録が1件もない / 期間内にない
    if (!r.best) {
      showChartEmpty('まだ記録がありません');
      return;
    }
    if (r.points.length === 0) {
      showChartEmpty('この期間の記録はありません');
      return;
    }
    gEl.empty.hidden = true;
    gEl.canvas.hidden = false;
    drawChart(r.points, unit);
  }

  function showChartEmpty(message) {
    if (graph.chart) { graph.chart.destroy(); graph.chart = null; }
    gEl.canvas.hidden = true;
    gEl.empty.textContent = message;
    gEl.empty.hidden = false;
  }

  function drawChart(points, unit) {
    if (typeof Chart === 'undefined') {
      showChartEmpty('グラフを読み込めませんでした(通信を確認してください)');
      return;
    }
    const data = points.map((p) => ({ x: ymdToTime(p.date), y: p.value }));
    const minX = data[0].x;
    const maxX = data[data.length - 1].x;
    // 1点だけのときも見やすいよう前後に余白を取る
    const pad = Math.max(DAY_MS, Math.round((maxX - minX) * 0.05));
    const spanDays = Math.max(1, Math.round((maxX - minX + 2 * pad) / DAY_MS));
    const stepDays = Math.max(1, Math.ceil(spanDays / 5));

    const accent = cssVar('--accent');
    const muted = cssVar('--muted');
    const line = cssVar('--line');

    if (graph.chart) graph.chart.destroy();
    graph.chart = new Chart(gEl.canvas, {
      type: 'line',
      data: {
        datasets: [{
          data,
          borderColor: accent,
          backgroundColor: accent,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: (items) => timeToShort(items[0].parsed.x),
              label: (item) => fmtNum(item.parsed.y) + ' ' + unit,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: minX - pad,
            max: maxX + pad,
            ticks: {
              color: muted,
              stepSize: stepDays * DAY_MS,
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6,
              callback: (v) => timeToShort(v),
            },
            grid: { display: false },
            border: { color: line },
          },
          y: {
            beginAtZero: false,
            grace: '10%',
            ticks: { color: muted, maxTicksLimit: 6, callback: (v) => fmtNum(v) },
            grid: { color: line },
            border: { display: false },
          },
        },
      },
    });
  }

  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', async () => {
      graph.period = seg.dataset.period;
      document.querySelectorAll('.seg').forEach((s) => {
        const active = s === seg;
        s.classList.toggle('is-active', active);
        s.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      await renderGraph();
    });
  });

  // ダークモードの切り替えでグラフの色を合わせ直す
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!$('screen-graph').hidden) renderGraph();
    });
  }

  // ---------- 下部タブ ----------

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.screen;
      if (name === 'graph') refreshGraph();
      document.querySelectorAll('.tab').forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        if (active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
      });
      document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== 'screen-' + name; });
      window.scrollTo(0, 0);
    });
  });

  // ---------- 起動 ----------

  async function init() {
    el.date.value = DB.today();
    DB.requestPersistentStorage();
    await loadExercises();
  }

  init();
})();
