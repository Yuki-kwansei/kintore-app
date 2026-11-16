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
      b.addEventListener('click', () => selectExercise(ex.id));
      el.exerciseList.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip chip-add';
    add.textContent = '＋追加';
    add.addEventListener('click', addExerciseTemporary);
    el.exerciseList.appendChild(add);
    el.exerciseEmpty.hidden = state.exercises.length > 0;
  }

  // 【仮】ステップ4で正式な種目追加シートに置き換える
  async function addExerciseTemporary() {
    const name = window.prompt('種目名を入力してください');
    if (name === null) return;
    const typeNo = window.prompt('記録タイプを番号で選んでください\n1: 重さ×回数\n2: 回数のみ\n3: 時間のみ(秒)', '1');
    if (typeNo === null) return;
    const type = { '1': 'weight_reps', '2': 'reps', '3': 'time' }[typeNo.trim()];
    if (!type) { window.alert('1〜3の番号で選んでください'); return; }

    const r = await DB.addExercise(name, type);
    if (r.ok) {
      await loadExercises();
      await selectExercise(r.exerciseId);
      return;
    }
    if (r.error === 'duplicate') {
      window.alert(r.message);
      await selectExercise(r.exerciseId);
      return;
    }
    if (r.error === 'duplicate_hidden') {
      if (!window.confirm(r.message)) return;
      const u = await DB.updateExercise(r.exerciseId, { visible: true });
      if (!u.ok) { window.alert(u.message); return; }
      await loadExercises();
      await selectExercise(r.exerciseId);
      return;
    }
    window.alert(r.message);
  }

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

  // ---------- 下部タブ ----------

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.screen;
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
