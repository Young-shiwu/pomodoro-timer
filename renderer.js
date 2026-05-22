// ============================================================================
// renderer.js — 番茄钟渲染进程逻辑
// 本文件在 Electron 窗口的浏览器环境中运行，负责 UI、计时器、音效，
// 并通过 preload 暴露的 window.pomodoro 与主进程通信（通知、托盘标题、托盘菜单）。
// ============================================================================

// --- 常量 ---
// 工作阶段时长：25 分钟（秒）
const WORK_SECONDS = 25 * 60;
// 休息阶段时长：5 分钟（秒）
const BREAK_SECONDS = 5 * 60;
// SVG 圆环周长（半径 r=90），用于 stroke-dashoffset 计算进度
const CIRCUMFERENCE = 2 * Math.PI * 90; // ≈ 565.49

// --- 应用状态（单一数据源）---
const state = {
  phase: 'work',              // 当前阶段：'work' 工作 | 'break' 休息
  status: 'idle',             // 计时状态：'idle' 未开始 | 'running' 运行中 | 'paused' 已暂停
  remainingSeconds: WORK_SECONDS, // 当前阶段剩余秒数
  totalSeconds: WORK_SECONDS,   // 当前阶段总秒数（用于进度环比例）
  sessionCount: 0,            // 已完成的工作番茄数（每完成一次工作 +1）
  soundEnabled: true,         // 是否播放完成提示音
  intervalId: null,           // setInterval 句柄，暂停/重置时需清除
  audioCtx: null,             // Web Audio API 上下文，懒加载复用
};

// --- DOM 元素引用（与 index.html 中的 id 对应）---
const container = document.getElementById('container');
const modeIndicator = document.getElementById('modeIndicator');
const timerText = document.getElementById('timerText');
const progressFill = document.getElementById('progressFill');
const sessionCount = document.getElementById('sessionCount');
const btnStart = document.getElementById('btnStart');
const btnPause = document.getElementById('btnPause');
const btnReset = document.getElementById('btnReset');
const soundToggle = document.getElementById('soundToggle');

// --- 音效 ---
/**
 * 获取或创建 AudioContext（浏览器要求用户交互后才可播放，此处在点击开始后使用）
 */
function getAudioContext() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.audioCtx;
}

/**
 * 阶段结束时播放三声上升音（C5、E5、G5），用振荡器 + 增益包络实现短促 beep
 */
function playCompletionSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    // 三个频率依次播放，间隔 0.15 秒
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.15;
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25); // 淡出避免爆音
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch (e) {
    // AudioContext 异常时静默失败，不影响计时
  }
}

// --- 系统通知（经 preload → ipcMain → Electron Notification）---
function notifyCompletion() {
  if (state.phase === 'work') {
    // 注意：调用时 phase 仍为 'work'，表示「刚完成工作」
    window.pomodoro.notify('工作完成!', '该休息一下了。');
  } else {
    window.pomodoro.notify('休息结束!', '开始专注吧。');
  }
}

// --- 托盘图标悬停标题（经 preload 更新主进程 Tray tooltip）---
function updateTray() {
  const mins = Math.floor(state.remainingSeconds / 60).toString().padStart(2, '0');
  const secs = (state.remainingSeconds % 60).toString().padStart(2, '0');
  const label = state.phase === 'work' ? '工作' : '休息';
  const text = state.status === 'running'
    ? `${label} - ${mins}:${secs}`
    : `${label} - 已暂停`;
  window.pomodoro.updateTrayTitle(text);
}

// --- 界面刷新（所有状态变化后应调用，保持 UI 与 state 一致）---
function updateUI() {
  // 中央大号倒计时 MM:SS
  const mins = Math.floor(state.remainingSeconds / 60).toString().padStart(2, '0');
  const secs = (state.remainingSeconds % 60).toString().padStart(2, '0');
  timerText.textContent = `${mins}:${secs}`;

  // 圆环进度：剩余比例越大，strokeDashoffset 越小（露出越多描边）
  const progress = state.remainingSeconds / state.totalSeconds;
  progressFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);

  // 休息模式切换容器样式与顶部模式文案
  if (state.phase === 'break') {
    container.classList.add('mode--break');
    modeIndicator.textContent = '休息中';
  } else {
    container.classList.remove('mode--break');
    modeIndicator.textContent = '工作中';
  }

  // 已完成番茄数
  sessionCount.textContent = `已完成: ${state.sessionCount}`;

  // 开始/暂停按钮互斥：运行中只能暂停，暂停或未开始只能开始/继续
  if (state.status === 'running') {
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnStart.textContent = '开始';
  } else {
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnStart.textContent = state.status === 'paused' ? '继续' : '开始';
  }

  // 同步提示音开关复选框
  soundToggle.checked = state.soundEnabled;

  updateTray();
}

// --- 阶段切换 ---
/**
 * 工作倒计时归零后：进入休息，自动开始 5 分钟休息计时
 */
function transitionToBreak() {
  state.phase = 'break';
  state.totalSeconds = BREAK_SECONDS;
  state.remainingSeconds = BREAK_SECONDS;
  state.status = 'running';
  startInterval();
}

/**
 * 休息倒计时归零后：回到工作阶段，重置为 25 分钟，状态为 idle（需用户再点「开始」）
 */
function transitionToWork() {
  state.phase = 'work';
  state.totalSeconds = WORK_SECONDS;
  state.remainingSeconds = WORK_SECONDS;
  state.status = 'idle';
}

// --- 计时核心 ---
/** 每秒执行一次 tick；会先清除旧 interval 避免重复定时器 */
function startInterval() {
  if (state.intervalId) clearInterval(state.intervalId);
  state.intervalId = setInterval(tick, 1000);
}

/**
 * 每秒回调：减 1 秒；到 0 时根据 phase 完成一次番茄或结束休息，并触发通知/音效
 */
function tick() {
  state.remainingSeconds--;

  if (state.remainingSeconds <= 0) {
    clearInterval(state.intervalId);
    state.intervalId = null;

    if (state.phase === 'work') {
      // 完成一个工作番茄
      state.sessionCount++;
      notifyCompletion();
      if (state.soundEnabled) playCompletionSound();
      transitionToBreak(); // 自动进入并启动休息
    } else {
      // 休息结束
      notifyCompletion();
      if (state.soundEnabled) playCompletionSound();
      transitionToWork(); // 回到工作，但不自动开始
    }
  }

  updateUI();
}

// --- 用户操作 ---
/** 开始或继续：若时间已耗尽则先填满当前阶段总时长 */
function start() {
  if (state.remainingSeconds <= 0) {
    state.remainingSeconds = state.totalSeconds;
  }
  state.status = 'running';
  startInterval();
  updateUI();
}

/** 暂停：清除定时器，保留剩余秒数 */
function pause() {
  state.status = 'paused';
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  updateUI();
}

/** 重置：停止计时，回到工作阶段 25:00，会话计数不清零 */
function reset() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  state.phase = 'work';
  state.status = 'idle';
  state.totalSeconds = WORK_SECONDS;
  state.remainingSeconds = WORK_SECONDS;
  updateUI();
}

// --- 事件绑定 ---
btnStart.addEventListener('click', start);
btnPause.addEventListener('click', pause);
btnReset.addEventListener('click', reset);
soundToggle.addEventListener('change', (e) => {
  state.soundEnabled = e.target.checked;
});

// 托盘右键菜单「开始/暂停」「重置」经主进程 send → 此处接收
window.pomodoro.onTrayAction(({ action }) => {
  switch (action) {
    case 'toggle':
      if (state.status === 'running') pause();
      else start();
      break;
    case 'reset':
      reset();
      break;
  }
});

// --- 初始化 ---
// 圆环使用 dasharray = 周长，dashoffset 控制可见弧长；初始为满环
progressFill.style.strokeDasharray = CIRCUMFERENCE;
progressFill.style.strokeDashoffset = 0;
updateUI();
