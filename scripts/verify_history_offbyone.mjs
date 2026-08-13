// 独立复刻 historyStore 修复后的 undo/redo 逻辑，验证 off-by-one 是否消除。
// 模型：past 存"修改前"的快照（与 projectStore.mutate 一致）。

function makeStore() {
  const state = { past: [], future: [], maxHistory: 50 };
  const pushSnapshot = (s) => {
    const past = [...state.past, s];
    if (past.length > state.maxHistory) past.shift();
    state.past = past; state.future = [];
  };
  // —— 修复后的实现 ——
  const undo = (current) => {
    if (state.past.length === 0) return null;
    const previous = state.past[state.past.length - 1];
    state.past = state.past.slice(0, -1);
    state.future = [current, ...state.future];
    return previous;
  };
  const redo = (current) => {
    if (state.future.length === 0) return null;
    const next = state.future[0];
    state.past = [...state.past, current];
    state.future = state.future.slice(1);
    return next;
  };
  return { state, pushSnapshot, undo, redo };
}

// 用 id 代表状态（S0/S1/S2...），便于断言
const S = (id) => ({ id });
let live = S('S0');
const h = makeStore();

const apply = (snap) => { if (snap) live = snap; };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg, '| live=', live.id, 'past=', h.state.past.map(s=>s.id), 'future=', h.state.future.map(s=>s.id)); process.exit(1); } else console.log('ok  :', msg, '-> live=', live.id); };

// 初始 S0
// 改1：修改前 push(S0) -> S1
h.pushSnapshot(live); live = S('S1');
// 改2：修改前 push(S1) -> S2
h.pushSnapshot(live); live = S('S2');

console.log('初始: live=S2, past=', h.state.past.map(s=>s.id), 'future=', h.state.future.map(s=>s.id));

// 撤销1：应回到 S1（修复前会错误地回到 S0）
apply(h.undo(live)); assert(live.id === 'S1', 'undo#1 回到 S1');

// 重做1：应回到 S2
apply(h.redo(live)); assert(live.id === 'S2', 'redo#1 回到 S2');

// 撤销2次：S2 -> S1 -> S0
apply(h.undo(live)); assert(live.id === 'S1', 'undo#2a 回到 S1');
apply(h.undo(live)); assert(live.id === 'S0', 'undo#2b 回到 S0（不再多退一级）');

// 重做2次：S0 -> S1 -> S2
apply(h.redo(live)); assert(live.id === 'S1', 'redo#2a 回到 S1');
apply(h.redo(live)); assert(live.id === 'S2', 'redo#2b 回到 S2');

// 撤销后可继续编辑应清空 future（pushSnapshot 清空 future）
apply(h.undo(live));            // S2 -> S1
h.pushSnapshot(live); live = S('S3');  // 新分支，future 应清空
assert(h.state.future.length === 0, '新分支后 future 清空');
assert(live.id === 'S3', '新编辑产生 S3');

// 撤销应回到 S1（push 的是 S1）
apply(h.undo(live)); assert(live.id === 'S1', 'undo 新分支回到 S1');

// 边界：空栈撤销/重做返回 null
const empty = makeStore();
assert(empty.undo(S('X')) === null, '空栈 undo 返回 null');
assert(empty.redo(S('X')) === null, '空栈 redo 返回 null');

console.log('\nALL PASS ✅  off-by-one 已修复');
