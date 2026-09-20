/* 听力专项练习引擎
 * 功能: 音频播放控制 + 答题 + 原文查看 + 进度记录
 * 依赖: 无外部库，纯 vanilla JS
 */
(function () {
  'use strict';

  /* ===== 工具函数 ===== */
  const $ = (s, p) => (p || document).querySelector(s);
  const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
  const fmt = t => {
    if (!isFinite(t)) return '00:00';
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  /* ===== 状态存储 ===== */
  const STORE_KEY = 'LISTENING_PROGRESS';
  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function saveProgress(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {}
  }

  /* ===== 练习引擎 ===== */
  class ListeningPractice {
    constructor(container, data, options = {}) {
      this.container = container;
      this.data = data;
      this.options = Object.assign({
        mode: 'practice',  // 'practice' | 'sim'
        section: null,      // null = all, or section id
        audioBase: 'data/N2/audio/'
      }, options);

      this.questions = this.filterQuestions();
      this.current = 0;
      this.answers = {};
      this.playCounts = {};
      this.speed = 1;
      this.finished = false;

      this.audio = new Audio();
      this.audio.preload = 'auto';

      this.progress = loadProgress();
      this.render();
    }

    filterQuestions() {
      let qs = this.data.questions;
      if (this.options.section) {
        qs = qs.filter(q => q.section === this.options.section);
      }
      return qs;
    }

    /* ===== 渲染 ===== */
    render() {
      const q = this.questions[this.current];
      const total = this.questions.length;
      const section = this.data.meta.sections.find(s => s.id === q.section);

      this.container.innerHTML = `
        <div class="lp-header">
          <a class="lp-back" href="index.html" title="返回">←</a>
          <h2>${this.data.meta.exam.replace('-', '.')} ${section ? section.name : ''}</h2>
          <span class="lp-count">${this.current + 1} / ${total}</span>
        </div>

        <div class="mode-bar">
          <button class="mode-btn ${this.options.mode === 'practice' ? 'on' : ''}" data-mode="practice">练习模式</button>
          <button class="mode-btn ${this.options.mode === 'sim' ? 'on' : ''}" data-mode="sim">模拟模式</button>
          <span style="font-size:12px;color:var(--muted);align-self:center;margin-left:8px">
            ${this.options.mode === 'practice' ? '可重复播放・答题后看原文' : '只播一次・全部答完看原文'}
          </span>
        </div>

        <div class="q-nav" id="qnav"></div>
        <div id="player-area"></div>
        <div id="question-area"></div>
        <div class="lp-actions" id="actions"></div>
      `;

      this.renderNav();
      this.renderPlayer(q);
      this.renderQuestion(q);
      this.renderActions();
      this.bindEvents();
    }

    renderNav() {
      const nav = $('#qnav', this.container);
      const dots = this.questions.map((q, i) => {
        let cls = 'q-dot';
        if (i === this.current) cls += ' cur';
        else if (this.answers[q.id] !== undefined) {
          cls += this.answers[q.id].correct ? ' correct' : ' wrong';
        }
        return `<button class="${cls}" data-idx="${i}">${q.qNo}</button>`;
      }).join('');
      nav.innerHTML = `
        <button class="nav-btn" id="btn-prev" ${this.current === 0 ? 'disabled' : ''}>上一题</button>
        <div class="q-dots">${dots}</div>
        <button class="nav-btn" id="btn-next" ${this.current >= this.questions.length - 1 ? 'disabled' : ''}>下一题</button>
      `;
    }

    renderPlayer(q) {
      const area = $('#player-area', this.container);
      const audioSrc = this.options.audioBase + q.audio;
      const count = this.playCounts[q.id] || 0;
      const isSim = this.options.mode === 'sim';
      const canPlay = !isSim || count === 0;

      area.innerHTML = `
        <div class="player-card">
          <div id="audio-missing-msg"></div>
          <div class="player-top">
            <button class="play-btn" id="play-btn" ${canPlay ? '' : 'disabled'} title="${isSim && !canPlay ? '模拟模式只能播放一次' : '播放'}">
              <span class="ico-play">▶</span>
              <span class="ico-pause">⏸</span>
            </button>
            <div class="player-info">
              <div class="player-title">問題${q.section} ・ ${q.qNo}番</div>
              <div class="player-status" id="player-status">点击播放音频</div>
            </div>
            <div class="play-count">已播 <b id="play-count-num">${count}</b> 回${isSim ? ' (限1回)' : ''}</div>
          </div>
          <div class="progress-wrap" id="progress-wrap">
            <div class="progress-fill" id="progress-fill" style="width:0%"></div>
          </div>
          <div class="player-controls">
            <button class="ctrl-btn" id="btn-replay" title="从头播放">⟲ 重播</button>
            <button class="ctrl-btn" id="btn-back5" title="后退5秒">-5s</button>
            <button class="ctrl-btn" id="btn-fwd5" title="前进5秒">+5s</button>
            <span class="time-display" id="time-display">00:00 / 00:00</span>
            <div class="speed-group">
              ${[0.75, 1, 1.25, 1.5].map(s =>
                `<button class="speed-btn ${s === this.speed ? 'on' : ''}" data-speed="${s}">${s}x</button>`
              ).join('')}
            </div>
          </div>
        </div>
      `;

      // 尝试加载音频
      this.audio.src = audioSrc;
      this.audio.playbackRate = this.speed;
      this.audio.load();

      this.audio.onerror = () => {
        const msg = $('#audio-missing-msg', this.container);
        if (msg) {
          msg.innerHTML = `<div class="audio-missing">⚠ 音频文件未找到: <code>${audioSrc}</code><br>请将 MP3 文件放入 <code>listening/data/N2/audio/</code> 目录。命名规则: <code>${q.audio}</code></div>`;
        }
        const btn = $('#play-btn', this.container);
        if (btn) btn.disabled = true;
      };

      this.audio.oncanplay = () => {
        const msg = $('#audio-missing-msg', this.container);
        if (msg) msg.innerHTML = '';
      };
    }

    renderQuestion(q) {
      const area = $('#question-area', this.container);
      const answered = this.answers[q.id] !== undefined;
      const hasOptions = q.options && q.options.some(o => o !== '');

      let optsHtml = '';
      if (hasOptions) {
        optsHtml = `<div class="opt-list" ${answered ? 'data-locked' : ''} id="opt-list">
          ${q.options.map((opt, i) => {
            if (!opt) return '';
            let cls = 'opt-item';
            if (answered) {
              if (i + 1 === q.answer) cls += ' correct';
              else if (this.answers[q.id] && this.answers[q.id].selected === i + 1 && i + 1 !== q.answer) cls += ' wrong';
            } else if (this._selected === i + 1) {
              cls += ' selected';
            }
            return `<div class="${cls}" data-val="${i + 1}">
              <span class="oi-num">${i + 1}</span>
              <span>${opt}</span>
            </div>`;
          }).join('')}
        </div>`;
      }

      let resultHtml = '';
      if (answered) {
        const a = this.answers[q.id];
        resultHtml = `<div class="result-bar ${a.correct ? 'ok' : 'ng'}">
          ${a.correct ? '✓ 正解' : `✗ 不正解 — 正确答案: ${q.answer}`}
        </div>`;
      }

      // 详解模块
      let explainHtml = '';
      const showExplain = answered && (this.options.mode === 'practice' || this.finished);
      const hasExplainData = q.transcript || q.translation || (q.vocab && q.vocab.length) || (q.grammar && q.grammar.length);

      if (hasExplainData) {
        const vocabHtml = (q.vocab && q.vocab.length)
          ? `<table class="vocab-table"><thead><tr><th>単語</th><th>読み</th><th>意味</th></tr></thead><tbody>${q.vocab.map(v =>
              `<tr><td class="vt-word">${v.word}</td><td class="vt-reading">${v.reading || ''}</td><td class="vt-meaning">${v.meaning || ''}</td></tr>`
            ).join('')}</tbody></table>`
          : '<p class="ep-empty">暂无单词数据</p>';

        const grammarHtml = (q.grammar && q.grammar.length)
          ? q.grammar.map(g => `<div class="grammar-item">
              <div class="gi-pattern">${g.pattern}</div>
              <div class="gi-meaning">${g.meaning}</div>
              ${g.example ? `<div class="gi-example"><div class="gi-jp">${g.example}</div>${g.exampleZh ? `<div class="gi-zh">${g.exampleZh}</div>` : ''}</div>` : ''}
            </div>`).join('')
          : '<p class="ep-empty">暂无语法数据</p>';

        explainHtml = `<div class="explain-box ${showExplain ? '' : 'locked'}">
          <button class="explain-toggle" id="explain-toggle">
            <span class="et-ico">▶</span>
            <span>${showExplain ? '详解' : '详解（答题后展开）'}</span>
          </button>
          <div class="explain-body">
            <div class="explain-tabs">
              <button class="explain-tab on" data-tab="transcript">原文</button>
              <button class="explain-tab" data-tab="translation">中文译文</button>
              <button class="explain-tab" data-tab="vocab">重点单词</button>
              <button class="explain-tab" data-tab="grammar">语法</button>
            </div>
            <div class="explain-panel on" data-panel="transcript">
              <div class="ep-transcript">${q.transcript || '<span class="ep-empty">暂无原文数据</span>'}</div>
            </div>
            <div class="explain-panel" data-panel="translation">
              <div class="ep-translation">${q.translation || '<span class="ep-empty">暂无译文数据</span>'}</div>
            </div>
            <div class="explain-panel" data-panel="vocab">${vocabHtml}</div>
            <div class="explain-panel" data-panel="grammar">${grammarHtml}</div>
          </div>
        </div>`;
      }

      // 确认按钮（选项和详解之间）
      let confirmHtml = '';
      if (hasOptions && !answered) {
        confirmHtml = `<div class="confirm-row">
          <button class="btn primary" id="btn-confirm" ${this._selected ? '' : 'disabled'}>确认答案</button>
        </div>`;
      }

      area.innerHTML = `
        <div class="q-card">
          <div class="q-num">問題${q.section} ・ ${q.qNo}番</div>
          ${q.prompt ? `<div class="q-prompt-text">${q.prompt}</div>` : ''}
          ${q.question ? `<div class="q-question">${q.question}</div>` : ''}
          ${optsHtml}
          ${confirmHtml}
          ${resultHtml}
          ${explainHtml}
          ${!hasOptions && !answered ? '<p style="font-size:13px;color:var(--muted);margin-top:10px">此题选项数据待补充，可直接播放音频练习听力。</p>' : ''}
        </div>
      `;

      // 绑定详解折叠和 tab 切换
      if (hasExplainData) {
        const toggle = $('#explain-toggle', this.container);
        const box = toggle && toggle.closest('.explain-box');
        if (toggle && box) {
          if (!showExplain) {
            box.classList.add('locked');
            toggle.onclick = () => {};
            toggle.style.opacity = '.5';
            toggle.style.cursor = 'not-allowed';
          } else {
            toggle.onclick = () => box.classList.toggle('open');
          }
        }
        $$('.explain-tab', this.container).forEach(tab => {
          tab.onclick = () => {
            $$('.explain-tab', this.container).forEach(t => t.classList.remove('on'));
            $$('.explain-panel', this.container).forEach(p => p.classList.remove('on'));
            tab.classList.add('on');
            const panel = $(`[data-panel="${tab.dataset.tab}"]`, this.container);
            if (panel) panel.classList.add('on');
          };
        });
      }
    }

    renderActions() {
      const bar = $('#actions', this.container);
      const allAnswered = this.questions.every(q => this.answers[q.id] !== undefined);

      if (allAnswered) {
        bar.innerHTML = `<span class="spacer"></span><button class="btn primary" id="btn-finish">查看成绩</button>`;
        bar.style.display = 'flex';
      } else {
        bar.innerHTML = '';
        bar.style.display = 'none';
      }
    }

    /* ===== 事件绑定 ===== */
    bindEvents() {
      // 播放按钮
      const playBtn = $('#play-btn', this.container);
      if (playBtn) playBtn.onclick = () => this.togglePlay();

      // 进度条点击
      const pw = $('#progress-wrap', this.container);
      if (pw) pw.onclick = e => {
        const rect = pw.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        if (this.audio.duration) this.audio.currentTime = pct * this.audio.duration;
      };

      // 控制按钮
      const replay = $('#btn-replay', this.container);
      if (replay) replay.onclick = () => { this.audio.currentTime = 0; this.playAudio(); };
      const back5 = $('#btn-back5', this.container);
      if (back5) back5.onclick = () => { this.audio.currentTime = Math.max(0, this.audio.currentTime - 5); };
      const fwd5 = $('#btn-fwd5', this.container);
      if (fwd5) fwd5.onclick = () => { this.audio.currentTime = Math.min(this.audio.duration || 0, this.audio.currentTime + 5); };

      // 速度按钮
      $$('.speed-btn', this.container).forEach(btn => {
        btn.onclick = () => {
          this.speed = parseFloat(btn.dataset.speed);
          this.audio.playbackRate = this.speed;
          $$('.speed-btn', this.container).forEach(b => b.classList.toggle('on', b === btn));
        };
      });

      // 模式切换
      $$('.mode-btn', this.container).forEach(btn => {
        btn.onclick = () => {
          this.options.mode = btn.dataset.mode;
          this.audio.pause();
          this.render();
        };
      });

      // 选项点击
      $$('.opt-item', this.container).forEach(item => {
        item.onclick = () => {
          if (item.closest('[data-locked]')) return;
          this._selected = parseInt(item.dataset.val);
          $$('.opt-item', this.container).forEach(o => o.classList.remove('selected'));
          item.classList.add('selected');
          // 更新确认按钮状态
          const cb = $('#btn-confirm', this.container);
          if (cb) cb.disabled = false;
        };
      });

      // 导航点
      $$('.q-dot', this.container).forEach(dot => {
        dot.onclick = () => {
          this.goTo(parseInt(dot.dataset.idx));
        };
      });

      // 上/下一题（导航行）
      const prevBtn = $('#btn-prev', this.container);
      if (prevBtn) prevBtn.onclick = () => this.goTo(this.current - 1);
      const nextBtn = $('#btn-next', this.container);
      if (nextBtn) nextBtn.onclick = () => this.goTo(this.current + 1);

      // 确认答案（题目卡片内）
      const confirmBtn = $('#btn-confirm', this.container);
      if (confirmBtn) confirmBtn.onclick = () => this.confirmAnswer();

      // 查看成绩（底部栏）
      const finishBtn = $('#btn-finish', this.container);
      if (finishBtn) finishBtn.onclick = () => this.showScore();

      // 音频事件
      this.audio.ontimeupdate = () => this.updateProgress();
      this.audio.onplay = () => {
        playBtn && playBtn.classList.add('playing');
        const st = $('#player-status', this.container);
        if (st) st.textContent = '播放中…';
      };
      this.audio.onpause = () => {
        playBtn && playBtn.classList.remove('playing');
        const st = $('#player-status', this.container);
        if (st) st.textContent = '已暂停';
      };
      this.audio.onended = () => {
        playBtn && playBtn.classList.remove('playing');
        const st = $('#player-status', this.container);
        if (st) st.textContent = '播放完毕';
        // 模拟模式下禁用重播
        if (this.options.mode === 'sim') {
          const pb = $('#play-btn', this.container);
          if (pb) pb.disabled = true;
          const rb = $('#btn-replay', this.container);
          if (rb) rb.disabled = true;
        }
      };
    }

    togglePlay() {
      if (this.audio.paused) this.playAudio();
      else this.audio.pause();
    }

    playAudio() {
      const q = this.questions[this.current];
      // 模拟模式: 限制播放次数
      if (this.options.mode === 'sim' && (this.playCounts[q.id] || 0) >= 1) return;

      this.playCounts[q.id] = (this.playCounts[q.id] || 0) + 1;
      const cntEl = $('#play-count-num', this.container);
      if (cntEl) cntEl.textContent = this.playCounts[q.id];

      this.audio.play().catch(() => {});
    }

    updateProgress() {
      const fill = $('#progress-fill', this.container);
      const td = $('#time-display', this.container);
      if (fill && this.audio.duration) {
        fill.style.width = (this.audio.currentTime / this.audio.duration * 100) + '%';
      }
      if (td) {
        td.textContent = fmt(this.audio.currentTime) + ' / ' + fmt(this.audio.duration);
      }
    }

    goTo(idx) {
      if (idx < 0 || idx >= this.questions.length) return;
      this.audio.pause();
      this._selected = null;
      this.current = idx;
      this.render();
    }

    confirmAnswer() {
      if (!this._selected) return;
      const q = this.questions[this.current];
      if (this.answers[q.id] !== undefined) return;

      this.answers[q.id] = {
        selected: this._selected,
        correct: this._selected === q.answer
      };

      // 保存进度
      const key = this.data.meta.exam;
      if (!this.progress[key]) this.progress[key] = {};
      this.progress[key][q.id] = this.answers[q.id];
      saveProgress(this.progress);

      this._selected = null;
      this.renderQuestion(q);
      this.renderNav();
      this.renderActions();
      this.rebind();
    }

    /* 局部重渲染后重新绑定事件 */
    rebind() {
      const prevBtn = $('#btn-prev', this.container);
      if (prevBtn) prevBtn.onclick = () => this.goTo(this.current - 1);
      const nextBtn = $('#btn-next', this.container);
      if (nextBtn) nextBtn.onclick = () => this.goTo(this.current + 1);
      $$('.q-dot', this.container).forEach(dot => {
        dot.onclick = () => this.goTo(parseInt(dot.dataset.idx));
      });
      const confirmBtn = $('#btn-confirm', this.container);
      if (confirmBtn) confirmBtn.onclick = () => this.confirmAnswer();
      const finishBtn = $('#btn-finish', this.container);
      if (finishBtn) finishBtn.onclick = () => this.showScore();
    }

    showScore() {
      this.finished = true;
      const total = this.questions.length;
      const correct = Object.values(this.answers).filter(a => a.correct).length;
      const pct = Math.round(correct / total * 100);

      const area = $('#question-area', this.container);
      area.innerHTML = `
        <div class="score-panel">
          <div class="sc-big">${correct} / ${total}</div>
          <div class="sc-label">正确率 ${pct}%</div>
          <div class="sc-detail">
            ${this.data.meta.sections.map(s => {
              const sQs = this.questions.filter(q => q.section === s.id);
              const sCorrect = sQs.filter(q => this.answers[q.id] && this.answers[q.id].correct).length;
              return `${s.name}: ${sCorrect}/${sQs.length}`;
            }).join(' ・ ')}
          </div>
        </div>
        <div style="margin-top:16px;text-align:center">
          <button class="btn" id="btn-review">逐题回顾</button>
          <button class="btn primary" id="btn-restart" style="margin-left:8px">重新练习</button>
        </div>
      `;

      $('#btn-review', this.container).onclick = () => {
        this.finished = true;
        this.goTo(0);
      };
      $('#btn-restart', this.container).onclick = () => {
        this.answers = {};
        this.playCounts = {};
        this.finished = false;
        this._selected = null;
        this.current = 0;
        this.render();
      };

      // 隐藏底部操作栏
      const bar = $('#actions', this.container);
      if (bar) bar.style.display = 'none';
    }
  }

  /* ===== 导出 ===== */
  window.ListeningPractice = ListeningPractice;
})();
