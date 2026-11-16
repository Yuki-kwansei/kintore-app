// db.js — データ層(仕様書 3章・6章)
// 画面からは必ずこの window.DB の関数を経由してデータを出し入れする。
// すべての関数は Promise を返し、成功なら { ok: true, ... }、
// 失敗なら { ok: false, error: エラーコード, message: 日本語の説明 } を返す。
// 保存先を将来クラウドDBに替えるときは、このファイルだけを差し替える。
(function () {
  'use strict';

  // テストページは window.KINTORE_DB_NAME で別のDB名を使い、本番データに触れない
  const DB_NAME = window.KINTORE_DB_NAME || 'kintore';
  const DB_VERSION = 1;
  const STORES = ['exercises', 'workouts', 'meals'];
  const TYPES = ['weight_reps', 'reps', 'time'];
  const MEAL_CATEGORIES = ['朝', '昼', '夜', '間食'];
  const PERIODS = ['1m', '3m', 'all'];

  // ---------- IndexedDB の基本処理 ----------

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // 種目マスタ(1種目=1行)
        if (!db.objectStoreNames.contains('exercises')) {
          db.createObjectStore('exercises', { keyPath: 'id' });
        }
        // 筋トレ記録(1セット=1行)
        if (!db.objectStoreNames.contains('workouts')) {
          const s = db.createObjectStore('workouts', { keyPath: 'id' });
          s.createIndex('exerciseId', 'exerciseId');
          s.createIndex('date', 'date');
        }
        // 食事記録(1食=1行)
        if (!db.objectStoreNames.contains('meals')) {
          const s = db.createObjectStore('meals', { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 1つのトランザクションで fn を実行し、完了(コミット)後に fn の戻り値を返す
  async function run(storeNames, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      storeNames.forEach((n) => { stores[n] = t.objectStore(n); });
      let result;
      Promise.resolve()
        .then(() => fn(stores))
        .then((r) => { result = r; }, (err) => {
          try { t.abort(); } catch (e) { /* 既に終了 */ }
          reject(err);
        });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('トランザクションが中断されました'));
    });
  }

  // 例外が起きても必ず { ok: false } の形で返す
  function wrap(fn) {
    return async function (...args) {
      try {
        return await fn(...args);
      } catch (e) {
        return fail('exception', 'データの処理中にエラーが発生しました: ' + (e && e.message ? e.message : String(e)));
      }
    };
  }

  function fail(error, message, extra) {
    return Object.assign({ ok: false, error, message }, extra || {});
  }

  // ---------- 小さな道具 ----------

  function pad(n, len) { return String(n).padStart(len, '0'); }

  function formatDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  function today() { return formatDate(new Date()); }

  function isValidDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  // '1m' / '3m' / 'all' から開始日(YYYY-MM-DD)を返す。'all' は null
  function periodStart(period) {
    if (period === 'all') return null;
    const d = new Date();
    d.setMonth(d.getMonth() - (period === '1m' ? 1 : 3));
    return formatDate(d);
  }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  // 重複チェック用: 前後の空白を削り、全角半角・ひらがなカタカナ・大文字小文字をそろえる
  function normalizeName(s) {
    return String(s)
      .trim()
      .normalize('NFKC')
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .toLowerCase();
  }

  // フォームの文字列も受け付けて数値に直す。不正なら NaN
  function toNumber(v) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return NaN;
    return Number(v);
  }

  // 記録タイプに合わせてセットを検証し、保存用の値にそろえる
  function normalizeSet(type, set, index) {
    const label = (index + 1) + 'セット目';
    const s = set || {};
    if (type === 'weight_reps') {
      const weight = toNumber(s.weight);
      const reps = toNumber(s.reps);
      if (!Number.isFinite(weight) || weight < 0) return { error: label + 'の重さが正しくありません' };
      if (!Number.isInteger(reps) || reps <= 0) return { error: label + 'の回数が正しくありません' };
      return { weight, reps, seconds: null };
    }
    if (type === 'reps') {
      const reps = toNumber(s.reps);
      if (!Number.isInteger(reps) || reps <= 0) return { error: label + 'の回数が正しくありません' };
      return { weight: null, reps, seconds: null };
    }
    const seconds = toNumber(s.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return { error: label + 'の秒数が正しくありません' };
    return { weight: null, reps: null, seconds };
  }

  // 画面に返すセットは、記録タイプで使う値だけにする
  function publicSet(type, row) {
    if (type === 'weight_reps') return { weight: row.weight, reps: row.reps };
    if (type === 'reps') return { reps: row.reps };
    return { seconds: row.seconds };
  }

  // 3章の集計ルール: 1セットの値
  function setValue(type, row) {
    if (type === 'weight_reps') return row.weight * row.reps;
    if (type === 'reps') return row.reps;
    return row.seconds;
  }

  function publicExercise(e) {
    return { id: e.id, name: e.name, type: e.type, visible: e.visible, order: e.order, createdAt: e.createdAt };
  }

  // ---------- 種目マスタ ----------

  // options.all が true なら非表示も含めたすべて、省略時は表示中のみ
  async function getExercises(options) {
    const all = !!(options && options.all);
    const rows = await run(['exercises'], 'readonly', (s) => reqP(s.exercises.getAll()));
    const list = rows
      .filter((e) => all || e.visible)
      .sort((a, b) => a.order - b.order)
      .map(publicExercise);
    return { ok: true, exercises: list };
  }

  async function addExercise(name, type) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return fail('invalid_name', '種目名を入力してください');
    if (!TYPES.includes(type)) return fail('invalid_type', '記録タイプが正しくありません');
    const key = normalizeName(trimmed);

    return run(['exercises'], 'readwrite', async (s) => {
      const rows = await reqP(s.exercises.getAll());
      const same = rows.find((e) => normalizeName(e.name) === key);
      if (same && same.visible) {
        return fail('duplicate', '同じ種目がすでにあります', { exerciseId: same.id });
      }
      if (same) {
        return fail('duplicate_hidden', '非表示の種目があります。再表示しますか', { exerciseId: same.id });
      }
      const maxNum = rows.reduce((m, e) => {
        const n = parseInt(String(e.id).replace(/^ex_/, ''), 10);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0);
      const maxOrder = rows.reduce((m, e) => (e.order > m ? e.order : m), 0);
      const exercise = {
        id: 'ex_' + pad(maxNum + 1, 3),
        name: trimmed,
        type,
        visible: true,
        order: maxOrder + 1,
        createdAt: today(),
      };
      await reqP(s.exercises.add(exercise));
      return { ok: true, exerciseId: exercise.id, exercise: publicExercise(exercise) };
    });
  }

  // changes: { name?: 新しい名前, visible?: true/false }。記録タイプは変更できない
  async function updateExercise(exerciseId, changes) {
    const c = changes || {};
    let newName;
    if (c.name !== undefined) {
      newName = typeof c.name === 'string' ? c.name.trim() : '';
      if (!newName) return fail('invalid_name', '種目名を入力してください');
    }
    if (c.visible !== undefined && typeof c.visible !== 'boolean') {
      return fail('invalid_visible', '表示の値が正しくありません');
    }

    return run(['exercises'], 'readwrite', async (s) => {
      const rows = await reqP(s.exercises.getAll());
      const target = rows.find((e) => e.id === exerciseId);
      if (!target) return fail('not_found', '種目が見つかりません');
      if (newName !== undefined) {
        const key = normalizeName(newName);
        const same = rows.find((e) => e.id !== exerciseId && normalizeName(e.name) === key);
        if (same) {
          return fail(same.visible ? 'duplicate' : 'duplicate_hidden',
            same.visible ? '同じ種目がすでにあります' : '非表示の種目に同じ名前があります',
            { exerciseId: same.id });
        }
        target.name = newName;
      }
      if (c.visible !== undefined) target.visible = c.visible;
      await reqP(s.exercises.put(target));
      return { ok: true, exercise: publicExercise(target) };
    });
  }

  // 記録がゼロの種目だけ削除できる
  async function deleteExercise(exerciseId) {
    return run(['exercises', 'workouts'], 'readwrite', async (s) => {
      const target = await reqP(s.exercises.get(exerciseId));
      if (!target) return fail('not_found', '種目が見つかりません');
      const count = await reqP(s.workouts.index('exerciseId').count(exerciseId));
      if (count > 0) {
        return fail('has_records', '記録がある種目は削除できません。非表示にしてください');
      }
      await reqP(s.exercises.delete(exerciseId));
      return { ok: true };
    });
  }

  // ---------- 筋トレ記録 ----------

  // sets: weight_reps → [{ weight, reps }], reps → [{ reps }], time → [{ seconds }]
  // 同じ日・同じ種目に追加で保存した場合、セット番号は続きから振る
  async function addWorkout(date, exerciseId, sets) {
    if (!isValidDate(date)) return fail('invalid_date', '日付が正しくありません');
    if (!Array.isArray(sets) || sets.length === 0) return fail('no_sets', 'セットを1つ以上入力してください');

    return run(['exercises', 'workouts'], 'readwrite', async (s) => {
      const ex = await reqP(s.exercises.get(exerciseId));
      if (!ex) return fail('not_found', '種目が見つかりません');

      const normalized = [];
      for (let i = 0; i < sets.length; i++) {
        const r = normalizeSet(ex.type, sets[i], i);
        if (r.error) return fail('invalid_set', r.error);
        normalized.push(r);
      }

      const existing = await reqP(s.workouts.index('exerciseId').getAll(exerciseId));
      const startNo = existing
        .filter((w) => w.date === date)
        .reduce((m, w) => (w.setNo > m ? w.setNo : m), 0);
      const createdAt = new Date().toISOString();

      for (let i = 0; i < normalized.length; i++) {
        await reqP(s.workouts.add({
          id: newId('w_'),
          date,
          exerciseId,
          setNo: startNo + i + 1,
          weight: normalized[i].weight,
          reps: normalized[i].reps,
          seconds: normalized[i].seconds,
          createdAt,
        }));
      }
      return { ok: true, count: normalized.length };
    });
  }

  // 前回(いちばん新しい日付)のセット。記録がなければ date: null, sets: []
  async function getLastWorkout(exerciseId) {
    return run(['exercises', 'workouts'], 'readonly', async (s) => {
      const ex = await reqP(s.exercises.get(exerciseId));
      if (!ex) return fail('not_found', '種目が見つかりません');
      const rows = await reqP(s.workouts.index('exerciseId').getAll(exerciseId));
      if (rows.length === 0) return { ok: true, date: null, sets: [] };
      const lastDate = rows.reduce((m, w) => (w.date > m ? w.date : m), rows[0].date);
      const sets = rows
        .filter((w) => w.date === lastDate)
        .sort((a, b) => a.setNo - b.setNo)
        .map((w) => publicSet(ex.type, w));
      return { ok: true, date: lastDate, sets };
    });
  }

  // グラフ用: 日付ごとの合計値(3章の集計ルール)
  // points は期間内のみ。best(自己ベスト)と recentChange(直近の伸び = 最新 − その1つ前)は全期間で計算する
  async function getProgress(exerciseId, period) {
    const p = period || 'all';
    if (!PERIODS.includes(p)) return fail('invalid_period', '期間が正しくありません');

    return run(['exercises', 'workouts'], 'readonly', async (s) => {
      const ex = await reqP(s.exercises.get(exerciseId));
      if (!ex) return fail('not_found', '種目が見つかりません');
      const rows = await reqP(s.workouts.index('exerciseId').getAll(exerciseId));

      const byDate = new Map();
      rows.forEach((w) => {
        byDate.set(w.date, (byDate.get(w.date) || 0) + setValue(ex.type, w));
      });
      const allPoints = Array.from(byDate.entries())
        .map(([date, value]) => ({ date, value: round2(value) }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      let best = null;
      allPoints.forEach((pt) => { if (!best || pt.value > best.value) best = { date: pt.date, value: pt.value }; });

      const n = allPoints.length;
      const recentChange = n >= 2 ? round2(allPoints[n - 1].value - allPoints[n - 2].value) : null;

      const start = periodStart(p);
      const points = start ? allPoints.filter((pt) => pt.date >= start) : allPoints;

      return { ok: true, type: ex.type, points, best, recentChange };
    });
  }

  // ---------- 食事記録 ----------

  // 内容と kcal がどちらも空なら保存しない
  async function addMeal(date, category, content, kcal) {
    if (!isValidDate(date)) return fail('invalid_date', '日付が正しくありません');
    if (!MEAL_CATEGORIES.includes(category)) return fail('invalid_category', '区分が正しくありません');
    const text = typeof content === 'string' ? content.trim() : '';
    const kcalEmpty = kcal === null || kcal === undefined || (typeof kcal === 'string' && kcal.trim() === '');
    let kcalValue = null;
    if (!kcalEmpty) {
      kcalValue = toNumber(kcal);
      if (!Number.isFinite(kcalValue) || kcalValue < 0) return fail('invalid_kcal', 'kcalが正しくありません');
    }
    if (!text && kcalValue === null) return fail('empty', '食事メモが空のため保存しませんでした');

    const meal = {
      id: newId('m_'),
      date,
      category,
      content: text,
      kcal: kcalValue,
      createdAt: new Date().toISOString(),
    };
    await run(['meals'], 'readwrite', (s) => reqP(s.meals.add(meal)));
    return { ok: true, meal };
  }

  // period: '1m' / '3m' / 'all'(省略時 'all')。新しい順に返す
  async function getMeals(period) {
    const p = period || 'all';
    if (!PERIODS.includes(p)) return fail('invalid_period', '期間が正しくありません');
    const start = periodStart(p);
    const rows = await run(['meals'], 'readonly', (s) => {
      const idx = s.meals.index('date');
      return reqP(start ? idx.getAll(IDBKeyRange.lowerBound(start)) : idx.getAll());
    });
    rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1)));
    return { ok: true, meals: rows };
  }

  // ---------- バックアップ ----------

  async function exportAll() {
    const data = await run(STORES, 'readonly', async (s) => ({
      exercises: await reqP(s.exercises.getAll()),
      workouts: await reqP(s.workouts.getAll()),
      meals: await reqP(s.meals.getAll()),
    }));
    const backup = Object.assign({ app: 'kintore', version: DB_VERSION, exportedAt: new Date().toISOString() }, data);
    return { ok: true, data: backup, json: JSON.stringify(backup, null, 2) };
  }

  function validateBackup(b) {
    if (!b || typeof b !== 'object') return 'ファイルの形式が正しくありません';
    if (b.app !== 'kintore') return 'このアプリのバックアップファイルではありません';
    if (!Array.isArray(b.exercises) || !Array.isArray(b.workouts) || !Array.isArray(b.meals)) {
      return 'ファイルの中身が足りません';
    }
    const exIds = new Set();
    for (const e of b.exercises) {
      if (!e || typeof e.id !== 'string' || typeof e.name !== 'string' || !TYPES.includes(e.type) ||
          typeof e.visible !== 'boolean' || typeof e.order !== 'number') {
        return '種目マスタのデータが正しくありません';
      }
      exIds.add(e.id);
    }
    for (const w of b.workouts) {
      if (!w || typeof w.id !== 'string' || !isValidDate(w.date) || !exIds.has(w.exerciseId) ||
          typeof w.setNo !== 'number') {
        return '筋トレ記録のデータが正しくありません';
      }
    }
    for (const m of b.meals) {
      if (!m || typeof m.id !== 'string' || !isValidDate(m.date) || !MEAL_CATEGORIES.includes(m.category)) {
        return '食事記録のデータが正しくありません';
      }
    }
    return null;
  }

  // input: File / Blob、JSON文字列、または exportAll の data オブジェクト
  // 今のデータはすべて消して、ファイルの内容に置き換える
  async function importAll(input) {
    let backup;
    try {
      if (input instanceof Blob) backup = JSON.parse(await input.text());
      else if (typeof input === 'string') backup = JSON.parse(input);
      else backup = input;
    } catch (e) {
      return fail('invalid_file', 'JSONファイルとして読み込めませんでした');
    }
    const problem = validateBackup(backup);
    if (problem) return fail('invalid_file', problem);

    await run(STORES, 'readwrite', async (s) => {
      for (const name of STORES) await reqP(s[name].clear());
      for (const e of backup.exercises) await reqP(s.exercises.put(e));
      for (const w of backup.workouts) await reqP(s.workouts.put(w));
      for (const m of backup.meals) await reqP(s.meals.put(m));
    });
    return {
      ok: true,
      counts: { exercises: backup.exercises.length, workouts: backup.workouts.length, meals: backup.meals.length },
    };
  }

  // ---------- 永続ストレージ ----------

  // 起動時に呼ぶ。ブラウザにデータを消さないよう依頼する
  async function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) {
      return fail('unsupported', 'このブラウザは永続ストレージに対応していません');
    }
    const already = await navigator.storage.persisted();
    const persisted = already || await navigator.storage.persist();
    return { ok: true, persisted };
  }

  window.DB = {
    TYPES,
    MEAL_CATEGORIES,
    today,
    getExercises: wrap(getExercises),
    addExercise: wrap(addExercise),
    updateExercise: wrap(updateExercise),
    deleteExercise: wrap(deleteExercise),
    addWorkout: wrap(addWorkout),
    getLastWorkout: wrap(getLastWorkout),
    getProgress: wrap(getProgress),
    addMeal: wrap(addMeal),
    getMeals: wrap(getMeals),
    exportAll: wrap(exportAll),
    importAll: wrap(importAll),
    requestPersistentStorage: wrap(requestPersistentStorage),
  };
})();
