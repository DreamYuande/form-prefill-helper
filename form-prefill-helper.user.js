// ==UserScript==
// @name         表单预填助手：预填与定时提交
// @namespace    local.qqform.prefill
// @license      MIT
// @version      1.2.3
// @description  独立第三方表单工具：识别题目、保存预填、定时提交和日志；与平台官方无关联。
// @match        https://docs.qq.com/form/*
// @homepageURL  https://github.com/DreamYuande/form-prefill-helper
// @supportURL   https://github.com/DreamYuande/form-prefill-helper/issues
// @downloadURL  https://raw.githubusercontent.com/DreamYuande/form-prefill-helper/main/form-prefill-helper.user.js
// @updateURL    https://raw.githubusercontent.com/DreamYuande/form-prefill-helper/main/form-prefill-helper.user.js
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

/*
 * SPDX-License-Identifier: MIT
 * MIT License
 *
 * Copyright (c) 2026 DreamYuande
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

(() => {
  'use strict';
  // 协议依据：腾讯页面自身的 submitRecord、answersTransform、getXSRF。
  // 只适配普通收集表；不伪造文件、签名、定位和名单身份。
  const TEXT = { SIMPLE: 11, RICH: 11, TIME: 12, DATE: 15, TEMPERATURE: 16, SCALE: 20, RATING: 21 };
  const CHOICE = { RADIO: 8, CHECKBOX: 9, SELECT: 10 };
  const OMIT = new Set(['SEGMENTATION']);
  const clean = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const pad = v => String(v).padStart(2, '0');
  const supported = q => q.type in TEXT || q.type in CHOICE || OMIT.has(q.type);
  function parseTime(s) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(s || '') ? Date.parse(`${s}+08:00`) : NaN;
  }
  function openingTime(s, now = Date.now()) {
    const m = String(s).match(/(?:(\d{4})[-年/])?(\d{1,2})[-月/](\d{1,2})日?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*开始/);
    if (!m) return '';
    const y = m[1] || new Date(now + 28800000).getUTCFullYear();
    return `${y}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${pad(m[5])}:${pad(m[6] || 0)}`;
  }
  function normalize(raw) {
    const data = raw?.data || raw;
    const form = data?.initialAttributedText?.text ? JSON.parse(data.initialAttributedText.text) : data;
    if (!Array.isArray(form?.questions)) throw new Error('没有取得正式题目数据，请登录并打开填写页后重新识别。');
    // questions 是题目定义库；当前问卷实际采用的题目由 sections[].qlist 指定。
    // 换题型/删题后的旧定义不能再追加展示或写进提交答案。
    const sections = Array.isArray(form.sections) ? form.sections : [];
    const hasLists = sections.some(section => Array.isArray(section?.qlist));
    const ids = [...new Set(sections.flatMap(section => Array.isArray(section?.qlist) ? section.qlist.map(String) : []))];
    const definitions = new Map();
    for (const q of form.questions) if (q && q.id != null) definitions.set(String(q.id), q);
    if (hasLists && ids.some(id => !definitions.has(id))) throw new Error('当前题目列表与题目定义不一致，请刷新问卷后重新识别。');
    // 仅旧格式缺少 qlist 时回退到定义库；相同标题但不同编号的有效题目仍完整保留。
    const activeIds = hasLists ? ids : [...definitions.keys()];
    const questions = activeIds.map(id => definitions.get(id)).map(q => ({
      ...q, id: String(q.id), type: String(q.type || '').toUpperCase(), title: clean(q.title || '未命名题目'),
      options: (q.qdata?.options || []).map(o => ({ id: String(o.id), title: clean(o.title) })),
    }));
    return { formId: data.globalPadId || form.globalPadId, form, questions,
      ignoredCount: hasLists ? definitions.size - activeIds.length : 0 };
  }

  function buildAnswers(questions, values, required = new Set()) {
    const answers = [];
    for (const q of questions) {
      if (OMIT.has(q.type)) continue;
      if (!supported(q)) throw new Error(`暂不支持“${q.title}”的 ${q.type} 题型，请改用原网页。`);
      const v = values[q.id];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) {
        if (q.required || required.has(q.id)) throw new Error(`请预填必填项：${q.title}`);
        continue;
      }
      const answer = { id: q.id, data_type: q.dataType ?? 1, answer_type: TEXT[q.type] || CHOICE[q.type] };
      if (q.type in CHOICE) {
        const selected = Array.isArray(v) ? v : [v];
        if (q.type !== 'CHECKBOX' && selected.length !== 1) throw new Error(`${q.title}只能选一项。`);
        if (new Set(selected).size !== selected.length) throw new Error(`${q.title}存在重复选项。`);
        const opts = selected.map(id => q.options.find(o => o.id === String(id)));
        if (opts.some(o => !o)) throw new Error(`${q.title}的选项已经变化，请重新选择。`);
        answer.content = { multi_texts: { texts: opts.map(o => o.title) } };
        answer.selected_option_ids = opts.map(o => o.id);
      } else answer.content = { text: { text: String(v) } };
      answers.push(answer);
    }
    if (!answers.length) throw new Error('没有可提交的答案。');
    return answers;
  }
  // 先持久化 sending，再发送。网络异常一律视为结果未知，不自动重发。
  async function runAttempt(state, env) {
    if (state.phase !== 'armed' || env.now() < state.target) return false;
    state.phase = 'sending'; state.sentAt = env.now(); env.save(state);
    env.status('正在发送一次请求，等待腾讯服务器确认……');
    try {
      const r = await env.send(state.payload);
      if (r?.retcode === 0 && r.result?.seq != null) {
        state.phase = 'success'; state.seq = String(r.result.seq);
        state.message = `服务器已确认提交成功，记录号：${state.seq}`;
      } else if (typeof r?.retcode === 'number' && r.retcode !== 0) {
        const meanings = { 3: '没有提交权限', 5: '当前未开放收集或已停止', 9: '表单已删除', 15: '达到收集上限',
          18: '达到提交次数限制', 19: '姓名重复', 20: '不在指定名单中', 21: '并发锁定', 22: '不在允许周期',
          90218: '不在允许的提交时间', 90266: '数据校验失败' };
        state.phase = 'rejected';
        state.message = `服务器拒绝（${r.retcode}）：${meanings[r.retcode] || clean(r.msg || r.message || '请查看网页提示')}`;
      } else {
        state.phase = 'unknown'; state.message = '响应没有可确认的记录号。请核对网页记录，不会自动重发。';
      }
    } catch (e) {
      state.phase = 'unknown'; state.message = `请求结果未知：${e.message}。请先核对网页记录，不会自动重发。`;
    }
    env.save(state); env.status(state.message); return true;
  }
  // 独立的一次性定时器逐步逼近目标；不靠界面刷新轮询发请求，也不忙等。
  function nextDelay(remaining) {
    if (remaining <= 0) return 0;
    if (remaining > 60000) return Math.min(30000, remaining - 60000);
    if (remaining > 5000) return Math.min(1000, remaining - 5000);
    if (remaining > 1000) return 100;
    if (remaining > 100) return 20;
    return Math.max(1, remaining);
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { parseTime, openingTime, normalize, buildAnswers, runAttempt, nextDelay }; return;
  }
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const match = location.pathname.match(/^\/form\/(?:page\/|fill\/)?([^/]+)\/?$/);
  if (!match || !/^D[A-Za-z0-9_-]+$/.test(match[1])) return;
  if (location.hash && !/^#\/?(?:fill)?\/?(?:\?.*)?$/.test(location.hash)) return;
  if (document.getElementById('qqform-prefill-assistant')) return;
  const urlId = match[1], KEY = `qqform-prefill-v1:${urlId}`, TASK = `${KEY}:task`, OWNERKEY = `${KEY}:owner`;
  const OWNER = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let schema, required = new Set(), busy = false, owned = false, knownOpening = '', submitTimer = 0, logTimer = 0, activeTab = 'normal';
  const LOGKEY = `${KEY}:logs`;
  let logs = GM_getValue(LOGKEY, []);
  if (!Array.isArray(logs)) logs = [];
  const POSITION = 'qqform-prefill-panel-position-v1';
  let config = GM_getValue(KEY, { values: {}, time: '' });
  let state = GM_getValue(TASK, { phase: 'idle' });
  const host = document.createElement('div'); host.id = 'qqform-prefill-assistant';
  const ui = host.attachShadow({ mode: 'open' }); document.body.appendChild(host);
  ui.innerHTML = `<style>
    :host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:12px/1.45 "Microsoft YaHei",system-ui,sans-serif;color:#35475e;color-scheme:light}*{box-sizing:border-box}button,input,textarea,select{font:inherit}button{border:1px solid #e0e7f0;border-radius:7px;background:#fff;color:#5a6e88;padding:6px 10px;cursor:pointer}button:hover{background:#f2f6fd}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #85abe9;outline-offset:2px}[hidden]{display:none!important}
    #panel{pointer-events:auto;position:absolute;right:18px;top:40px;width:330px;height:400px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);display:flex;flex-direction:column;overflow:hidden;background:#fff;border:1px solid #dde6f0;border-radius:14px;box-shadow:0 14px 44px #25436525}
    header{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(110deg,#f1f6ff,#f1faf8);cursor:grab;touch-action:none;user-select:none}header.dragging{cursor:grabbing}.brand{width:25px;height:25px;display:grid;place-items:center;flex:none;border-radius:8px;background:#376ed2;color:#fff}.brand svg{width:17px;height:17px}.heading{flex:1;min-width:0}h3{font-size:13px;margin:0;color:#2b466b}.version{font-size:9px;font-weight:400;color:#8fa0b6;margin-left:5px}.grip{color:#9aafc2;font-size:15px}#close{border:0;background:#ffffffb0;width:24px;height:24px;padding:0;font-size:17px;color:#8b9bb0}
    .tabs{flex:none;display:flex;padding:0 12px;border-bottom:1px solid #eaf0f6;gap:18px}.tabs button{border:0;border-radius:0;padding:8px 3px 7px;background:transparent;font-size:11px;color:#91a0b2;border-bottom:2px solid transparent}.tabs button[aria-selected=true]{border-bottom-color:#3972d9;color:#356dcc;font-weight:600}.tabs span{font-size:9px;margin-left:3px;color:#a5b1c0}
    .body{flex:1;min-height:0;padding:10px 12px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#dce4ee transparent}.body::-webkit-scrollbar{width:4px}.body::-webkit-scrollbar-thumb{background:#dce4ee;border-radius:4px}p{margin:0}#summary{font-size:10px;color:#93a1b2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px}.section-heading{display:none}#fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px}.row{min-width:0}.row.wide{grid-column:1/-1}.title{display:block;font-size:10px;font-weight:500;color:#6e7f95;margin-bottom:3px}
    input:not([type=checkbox]),textarea,select{display:block;width:100%;min-width:0;padding:6px 8px;border:1px solid #e0e7f0;border-radius:7px;background:#f8fafd;color:#2c4565;font-size:11px}textarea{height:31px;min-height:31px;resize:vertical;line-height:17px}textarea::placeholder{color:#b0b9c7;font-size:10px}select{height:31px}input:not([type=checkbox]):focus,textarea:focus,select:focus{outline:none;border-color:#92b0e5;background:white;box-shadow:0 0 0 2px #edf3ff}.option{display:flex;align-items:center;gap:6px;font-size:10px;padding:4px 0}input[type=checkbox]{width:13px;height:13px;margin:0;accent-color:#3972d9;flex:none}fieldset{border:0;padding:0;margin:0;min-width:0}.warn{font-size:10px;color:#b27c50}
    .schedule{margin-top:10px;padding-top:9px;border-top:1px solid #edf1f7}.follow{display:flex;align-items:center;gap:5px;font-size:10px;color:#8090a6;margin-bottom:6px;cursor:pointer}.follow span:last-child{margin-left:auto;font-size:9px;color:#a8b3c1}.time-card>.title{display:none}#time{font-variant-numeric:tabular-nums;font-size:11px;padding:6px;background:#fafcff}#timehint{display:none}
    footer{flex:none;padding:8px 12px 9px;border-top:1px solid #eaf0f7;background:#fff}.timer{display:flex;align-items:center;justify-content:space-between;gap:5px;margin-bottom:5px}.timer-label{font-size:9px;color:#8ba0bb;display:flex;align-items:center;gap:4px}.dot{width:4px;height:4px;border-radius:50%;background:#9ab2d1}#count{font-size:14px;line-height:20px;font-weight:600;color:#3d6eb9;white-space:nowrap;font-variant-numeric:tabular-nums}#status{font-size:9px;line-height:14px;color:#92a0b2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:7px}#panel[data-phase=success] #count{color:#258376}#panel[data-phase=unknown] #status,#panel[data-phase=rejected] #status{color:#b0784b}.actions{display:grid;grid-template-columns:1fr auto;gap:7px}.primary{background:#3972d9;color:white;border-color:#3972d9;font-size:11px;font-weight:600}.primary:hover{background:#2f63c2}#stop{font-size:10px;color:#91a0b4}.secondary{display:flex;justify-content:center;gap:18px;margin-top:5px}.secondary button{border:0;padding:1px 3px;font-size:9px;color:#9aa9bc;background:transparent}.footnote{display:none}
    .metrics{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:9px}.metric{padding:7px 8px;background:#f7f9fd;border:1px solid #edf1f7;border-radius:8px;min-width:0}.metric span{display:block;font-size:9px;color:#9aa8ba}.metric b{display:block;font-size:11px;font-weight:500;color:#5d7799;margin-top:2px;white-space:nowrap}.log-tools{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;gap:6px}.log-tools span{font-size:9px;color:#a0adbd}.log-tools button{font-size:9px;padding:4px 7px}#log-list{margin:0;padding:0;list-style:none}.entry{padding:7px 0;border-bottom:1px solid #f0f3f8;display:grid;grid-template-columns:76px 1fr;gap:6px;font-size:10px;color:#718198;line-height:1.55;overflow-wrap:anywhere}.entry time{font:9px/1.7 Consolas,monospace;color:#9baabf}.entry[data-level=error]{color:#b17b4b}.entry[data-level=success]{color:#368976}.empty{font-size:10px;color:#a1aec0;padding:15px 0;text-align:center}.hint{font-size:10px;color:#9ba8b8;line-height:1.7}details{border-top:1px solid #edf1f7;margin-top:12px;padding-top:8px}summary{cursor:pointer;font-size:10px;color:#9aa9bb}details p{margin-top:7px}#clear{font-size:9px;color:#ae8c8c;background:#fffafb;border-color:#f1e6e9;margin-top:8px;padding:4px 6px}
    #open{pointer-events:auto;position:absolute;right:18px;bottom:22px;border:0;border-radius:22px;background:#3972d9;color:#fff;box-shadow:0 4px 18px #3972d938;padding:9px 13px;font-size:11px}@media(max-width:380px){#panel{right:8px;top:12px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style><section id="panel" role="dialog" aria-label="报名预填与定时提交" data-phase="idle"><header id="drag" title="按住标题栏拖动位置"><div class="brand" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 4V3h6v3H9V4M9 11h6M9 15h4"/></svg></div><div class="heading"><h3>表单预填助手<span class="version">1.2.3</span></h3></div><span class="grip" aria-hidden="true">⠿</span><button id="close" aria-label="收起" title="收起，计时继续">−</button></header>
    <nav class="tabs" role="tablist" aria-label="面板内容"><button id="tab-normal" role="tab" aria-selected="true" aria-controls="normal-page">常规</button><button id="tab-log" role="tab" aria-selected="false" aria-controls="log-page">日志<span id="log-count">0</span></button></nav>
    <div id="normal-page" class="body" role="tabpanel" aria-labelledby="tab-normal"><p id="summary">正在识别问卷……</p><fieldset id="config"><div class="section-heading"><span id="field-count"></span></div><div id="fields"></div><div class="schedule"><div class="time-card"><label class="follow"><input id="follow" type="checkbox" checked><span>跟随问卷开放时间</span><span>北京时间</span></label><label class="title" for="time">提交时间</label><input id="time" type="datetime-local" step="1"><p id="timehint"></p></div></div></fieldset></div>
    <div id="log-page" class="body" role="tabpanel" aria-labelledby="tab-log" hidden><div class="metrics"><div class="metric"><span>计划提交</span><b id="metric-target">—</b></div><div class="metric"><span>定时触发偏差</span><b id="metric-trigger">—</b></div><div class="metric"><span>请求发起偏差</span><b id="metric-sent">—</b></div><div class="metric"><span>响应耗时</span><b id="metric-network">—</b></div></div><div class="log-tools"><span>仅记录时间和状态</span><button id="copy-log">复制日志</button></div><ul id="log-list" aria-live="polite"></ul><details><summary>说明与本地记录</summary><p class="hint">按住标题栏拖动，收起后计时继续。默认跟随开放时间，手动修改可自定义。刷新或离开会取消定时，预填保留。</p><p class="hint">后台计时节流、系统时钟、网络及服务器处理均可能影响后台记录时间。日志中的偏差按本机时钟计算，不代表服务器入库耗时；复制日志可帮助定位。</p><p class="hint">仅适配普通收集表的常见题型，附件、签名、考试、名单和跳题等特殊流程暂不支持。验证码需自行处理。</p><button id="clear">清除本表预填及提交记录</button></details></div>
    <footer><div class="timer"><div class="timer-label"><span class="dot"></span>倒计时</div><div id="count">等待启动</div></div><div id="status" role="status">正在准备……</div><div class="actions"><button id="arm" class="primary">启动定时提交</button><button id="stop">取消</button></div><div class="secondary"><button id="save">保存预填</button><button id="scan">重新识别</button></div></footer></section><button id="open" hidden>报名助手</button>`;
  const $ = s => ui.querySelector(s);
  function clock(at) { return Number.isFinite(at) ? new Date(at + 28800000).toISOString().slice(11, 23) : '—'; }
  function addLog(message, level = 'info', at = Date.now()) {
    logs.push({ at, message: String(message), level }); logs = logs.slice(-80);
    // 日志写盘和绘制延后执行，不放在发请求之前的关键路径上。
    if (!logTimer) logTimer = setTimeout(() => { logTimer = 0; GM_setValue(LOGKEY, logs); renderLogs(); }, 50);
  }
  function renderLogs() {
    $('#log-count').textContent = String(logs.length);
    const t = state.timing || {};
    $('#metric-target').textContent = clock(state.target);
    $('#metric-trigger').textContent = Number.isFinite(t.triggerAt) ? `${t.triggerAt - state.target >= 0 ? '+' : ''}${t.triggerAt - state.target} ms` : '—';
    $('#metric-sent').textContent = Number.isFinite(t.requestAt) ? `${t.requestAt - state.target >= 0 ? '+' : ''}${t.requestAt - state.target} ms` : '—';
    $('#metric-network').textContent = Number.isFinite(t.duration) ? `${t.duration} ms` : '—';
    if (activeTab !== 'log') return;
    const list = $('#log-list'), fragment = document.createDocumentFragment();
    if (!logs.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = '暂无日志'; fragment.appendChild(li); }
    for (const entry of logs.slice().reverse()) {
      const li = document.createElement('li'); li.className = 'entry'; li.dataset.level = entry.level;
      const time = document.createElement('time'); time.textContent = clock(entry.at);
      const message = document.createElement('span'); message.textContent = entry.message; li.append(time, message); fragment.appendChild(li);
    }
    list.replaceChildren(fragment);
  }
  function switchTab(name, focus = false) {
    activeTab = name;
    for (const tab of ['normal', 'log']) {
      $(`#tab-${tab}`).setAttribute('aria-selected', String(tab === name));
      $(`#tab-${tab}`).tabIndex = tab === name ? 0 : -1;
      $(`#${tab === 'normal' ? 'normal' : 'log'}-page`).hidden = tab !== name;
    }
    if (name === 'log') renderLogs();
    if (focus) $(`#tab-${name}`).focus();
  }
  const status = s => {
    $('#status').textContent = s; $('#status').title = s; $('#panel').dataset.phase = state.phase || 'idle';
    if (logs.at(-1)?.message !== s) addLog(s, state.phase === 'success' ? 'success' : ['rejected', 'unknown'].includes(state.phase) ? 'error' : 'info');
  };
  const cookie = name => document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) || '';
  function persist(s) { GM_setValue(TASK, s); state = s; }
  function release() {
    clearTimeout(submitTimer); submitTimer = 0;
    if (localStorage.getItem(OWNERKEY) === OWNER) localStorage.removeItem(OWNERKEY); owned = false;
  }
  function display() {
    $('#panel').dataset.phase = state.phase || 'idle';
    const active = ['armed', 'sending'].includes(state.phase);
    $('#config').disabled = active;
    for (const id of ['save', 'scan', 'arm', 'clear']) $(`#${id}`).disabled = active;
    if (!owned && state.phase === 'sending') {
      $('#clear').disabled = false;
      status('检测到已经发出的请求，结果尚未确认。请先核对腾讯网页提交记录；核对后可清除本地记录。');
    } else if (state.message) status(state.message);
  }
  function collect() {
    if (!schema) throw new Error('题目尚未识别完成。');
    const values = {};
    for (const row of $('#fields').children) {
      const q = schema.questions.find(q => q.id === row.dataset.id);
      values[q.id] = q.type === 'CHECKBOX' ? Array.from(row.querySelectorAll('input:checked')).map(e => e.value) : row.querySelector('textarea,select')?.value || '';
    }
    return { values, time: $('#time').value, timeMode: $('#follow').checked ? 'auto' : 'manual' };
  }
  function save() { config = collect(); GM_setValue(KEY, config); return config; }
  function render() {
    $('#fields').replaceChildren();
    for (const q of schema.questions) {
      if (OMIT.has(q.type)) continue;
      const row = document.createElement('div'); row.className = `row${q.title.length > 8 || q.type === 'CHECKBOX' ? ' wide' : ''}`; row.dataset.id = q.id;
      const label = document.createElement('label'); label.className = 'title';
      label.textContent = `${q.title}${required.has(q.id) || q.required ? ' *' : ''}`; row.appendChild(label);
      const v = config.values?.[q.id];
      if (!supported(q)) {
        const note = document.createElement('p'); note.className = 'warn'; note.textContent = `暂不支持 ${q.type}，请使用原网页。`; row.appendChild(note);
      } else if (q.type === 'CHECKBOX') {
        for (const o of q.options) {
          const l = document.createElement('label'); l.className = 'option';
          const input = document.createElement('input'); input.type = 'checkbox'; input.value = o.id;
          input.checked = Array.isArray(v) && v.includes(o.id); l.append(input, document.createTextNode(` ${o.title}`)); row.appendChild(l);
        }
      } else if (q.type in CHOICE) {
        const select = document.createElement('select'); select.add(new Option('请选择', ''));
        for (const o of q.options) select.add(new Option(o.title, o.id)); select.value = v || ''; row.appendChild(select);
      } else {
        const input = document.createElement('textarea'); input.value = v || ''; input.placeholder = q.type === 'DATE' ? '按原表要求填写日期，例如 2026年10月31日' : q.type === 'TIME' ? '按原表要求填写时间，例如 20:26' : '在这里预填写'; row.appendChild(input);
      }
      $('#fields').appendChild(row);
    }
    $('#follow').checked = config.timeMode !== 'manual';
    if (!$('#follow').checked) $('#time').value = config.time || '';
    syncOpening();
    $('#field-count').textContent = `${schema.questions.filter(q => !OMIT.has(q.type)).length} 项`;
    requestAnimationFrame(keepInView);
    $('#summary').textContent = `${clean(document.querySelector('.form-header-title-content')?.textContent || document.title)} · ${schema.questions.filter(q => !OMIT.has(q.type)).length} 项`;
    display();
  }
  function syncOpening() {
    const header = document.querySelector('.form-header-time-setting') || document.querySelector('.form-header');
    const detected = openingTime(header?.innerText || header?.textContent || '');
    if (detected) knownOpening = detected;
    if (['armed', 'sending'].includes(state.phase)) return;
    if ($('#follow').checked) {
      $('#time').value = knownOpening;
      $('#timehint').textContent = knownOpening ? '已同步问卷开放时间；调整时间将切换为自定义。' : '暂未识别到开放时间。可等待页面加载，或直接手动设置。';
    } else $('#timehint').textContent = '当前使用自定义时间，重新勾选可恢复问卷开放时间。';
  }
  // 标题栏拖动：使用 Pointer Events 兼容鼠标与触屏，保持面板留在视口内。
  const panel = $('#panel'), drag = $('#drag');
  let dragging = null;
  function place(x, y) {
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(Number(x) || 8, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(Number(y) || 8, window.innerHeight - rect.height - 8));
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
  }
  function keepInView() {
    if (panel.hidden) return;
    const rect = panel.getBoundingClientRect(); place(rect.left, rect.top);
  }
  function showPanel() { panel.hidden = false; $('#open').hidden = true; requestAnimationFrame(keepInView); }
  drag.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragging = { id: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top };
    drag.setPointerCapture(e.pointerId); drag.classList.add('dragging'); e.preventDefault();
  });
  drag.addEventListener('pointermove', e => {
    if (dragging?.id === e.pointerId) place(e.clientX - dragging.x, e.clientY - dragging.y);
  });
  function finishDrag(e) {
    if (dragging?.id !== e.pointerId) return;
    dragging = null; drag.classList.remove('dragging');
    const rect = panel.getBoundingClientRect(); GM_setValue(POSITION, { x: rect.left, y: rect.top });
    if (drag.hasPointerCapture(e.pointerId)) drag.releasePointerCapture(e.pointerId);
  }
  drag.addEventListener('pointerup', finishDrag); drag.addEventListener('pointercancel', finishDrag);
  const savedPosition = GM_getValue(POSITION, null);
  if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) place(savedPosition.x, savedPosition.y);
  window.addEventListener('resize', keepInView);
  $('#follow').addEventListener('change', syncOpening);
  $('#time').addEventListener('input', () => { $('#follow').checked = false; syncOpening(); });
  let openingCheck = false;
  new MutationObserver(records => {
    if (openingCheck || !$('#follow').checked || !records.some(r => {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return el?.closest('.form-header') || Array.from(r.addedNodes).some(n => n.nodeType === 1 && (n.matches('.form-header') || n.querySelector('.form-header')));
    })) return;
    openingCheck = true;
    requestAnimationFrame(() => { openingCheck = false; syncOpening(); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  async function scan() {
    status('正在读取正式题目和选项……');
    const response = await fetch(`/form/data/get?id=${encodeURIComponent(urlId)}&normal=1&xsrf=${encodeURIComponent(cookie('TOK'))}`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`读取题目失败（HTTP ${response.status}）。请先登录腾讯文档，再重新识别。`);
    const json = await response.json();
    if (json.retcode !== 0) throw new Error(`读取失败（${json.retcode}）：${clean(json.msg || '请检查登录或访问权限')}`);
    schema = normalize(json); schema.formId ||= page.clientVars?.globalPadId;
    if (schema.ignoredCount) addLog(`已忽略 ${schema.ignoredCount} 个不在当前题目名单中的旧题目定义`);
    if (!schema.formId) throw new Error('没有识别到正式表单编号，已停止。');
    required = new Set(schema.questions.filter(q => q.required).map(q => q.id));
    for (const e of document.querySelectorAll('.question[data-qid]')) if (e.querySelector('.required-span')) required.add(e.dataset.qid);
    render(); status('识别完成。请预填并核对时间，再启动。尚未发送报名数据。'); display();
  }
  function hasContent(v) {
    return v && (Array.isArray(v) ? v.length > 0 : typeof v === 'object' ? Object.keys(v).length > 0 : true);
  }
  function verify() {
    if (schema.questions.some(q => !supported(q))) throw new Error('包含暂不支持的题型，已停止接口提交。');
    const f = schema.form;
    if (['taskConfig', 'cardConfig', 'sequenceConfig'].some(k => hasContent(f[k])) || /[?&]big=1(?:&|$)/.test(location.search)) throw new Error('考试、打卡、接龙或大规模表单暂不支持。');
    if (Object.keys(f).some(k => /logic|jump|condition|roster/i.test(k) && hasContent(f[k])) || schema.questions.some(q => Object.keys(q.qdata || {}).some(k => /logic|jump|condition/i.test(k) && hasContent(q.qdata[k])))) throw new Error('检测到名单或条件逻辑，请在原网页处理。');
    if (!cookie('TOK')) throw new Error('没有取得当前登录校验，请先登录再启动。');
    if (!navigator.locks) throw new Error('浏览器不支持防重复锁，请使用较新版本 Chrome 或 Edge。');
  }
  async function send(payload) {
    const token = cookie('TOK');
    if (!token) throw new Error('登录校验已失效，请先登录并核对提交记录。');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    const body = JSON.stringify(payload);
    const started = performance.now();
    state.timing ||= {};
    state.timing.requestAt = Date.now();
    try {
      // 在任何日志持久化和面板重绘之前启动网络请求。
      const pending = fetch(`/api/form/write/submit?xsrf=${encodeURIComponent(token)}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
      });
      addLog(`请求已发起，比计划时间晚 ${state.timing.requestAt - state.target} ms`, 'info', state.timing.requestAt);
      const response = await pending;
      state.timing.responseAt = Date.now();
      state.timing.duration = Math.round(performance.now() - started);
      state.timing.httpStatus = response.status || 200;
      const serverDate = response.headers?.get?.('Date');
      if (serverDate && Number.isFinite(Date.parse(serverDate))) {
        state.timing.serverDate = Date.parse(serverDate);
        addLog(`服务器响应头时间 ${clock(state.timing.serverDate)}（秒精度，不能据此确定入库时刻）`);
      }
      addLog(`收到响应 HTTP ${state.timing.httpStatus}，往返 ${state.timing.duration} ms`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      state.timing.resultAt = Date.now();
      addLog(`响应解析完成，状态码 ${result?.retcode ?? '未知'}`);
      return result;
    } catch (e) {
      state.timing.duration = Math.round(performance.now() - started);
      addLog(`请求异常：${e.message}，已等待 ${state.timing.duration} ms`, 'error');
      throw e;
    } finally { clearTimeout(timeout); }
  }
  async function arm() {
    syncOpening();
    const cfg = save(), target = parseTime(cfg.time);
    if (!Number.isFinite(target) || target <= Date.now()) throw new Error('请选择未来的提交时间（北京时间）。');
    const old = GM_getValue(TASK, { phase: 'idle' });
    if (['sending', 'unknown', 'success'].includes(old.phase)) throw new Error('已有提交或结果未知记录。请先核对网页，确需重新提交时再清除本地记录。');
    verify(); const answers = buildAnswers(schema.questions, cfg.values, required);
    const owner = localStorage.getItem(OWNERKEY);
    if (owner && owner !== OWNER) throw new Error('其他标签页已有定时，请先到该页取消；若该页已关闭，请清除记录再启动。');
    localStorage.setItem(OWNERKEY, OWNER); owned = true;
    persist({ phase: 'armed', target, owner: OWNER, payload: { form_id: schema.formId, answers, role: {} }, timing: {}, message: '定时已启动，到点提交一次。' }); display(); $('#count').textContent = '倒计时已启动'; addLog(`计划时间 ${clock(target)}；定时已启用`); scheduleNext(); renderLogs();
  }
  function cancel(message = '定时已取消，预填内容仍保留。') {
    const s = GM_getValue(TASK, { phase: 'idle' });
    if (s.phase === 'sending') { status('请求已经发出，不能撤销。请查看提交结果。'); return; }
    if (s.phase === 'armed') persist({ ...s, phase: 'cancelled', message });
    release(); display(); status(message); $('#count').textContent = '已停止';
  }
  async function execute(triggerAt) {
    const shared = GM_getValue(TASK, { phase: 'idle' });
    if (shared.phase !== 'armed' || shared.owner !== OWNER) { state = shared; release(); display(); return; }
    state = shared;
    if (Date.now() - state.target > 90000) { cancel('超过预定时间90秒，已停止。请重新核对时间。'); return; }
    if (Date.now() < state.target) return;
    state.timing = { ...(state.timing || {}), triggerAt, lockAt: Date.now() };
    await runAttempt(state, { now: Date.now, save: persist, send, status });
    release(); display(); renderLogs(); $('#count').textContent = state.phase === 'success' ? '提交成功' : '提交已结束，请查看结果';
  }
  function updateCountdown() {
    if (!owned || state.phase !== 'armed') return;
    const seconds = Math.max(0, Math.ceil((state.target - Date.now()) / 1000));
    const days = Math.floor(seconds / 86400);
    $('#count').textContent = `${days ? `${days}天 ` : ''}${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
    $('#open').textContent = `报名助手 · ${$('#count').textContent}`;
  }
  function scheduleNext() {
    clearTimeout(submitTimer); submitTimer = 0;
    if (!owned || state.phase !== 'armed') return;
    updateCountdown();
    const remaining = state.target - Date.now();
    submitTimer = setTimeout(async () => {
      submitTimer = 0;
      await tick();
      if (owned && state.phase === 'armed') scheduleNext();
    }, remaining <= 0 ? 100 : nextDelay(remaining));
  }
  async function tick() {
    if (busy || !owned || state.phase !== 'armed' || Date.now() < state.target) return;
    const triggerAt = Date.now();
    busy = true;
    try { await navigator.locks.request(KEY, { ifAvailable: true }, async lock => { if (lock) await execute(triggerAt); }); }
    catch (e) { status(e.message); }
    finally { busy = false; }
  }
  const guard = fn => async () => { try { await fn(); } catch (e) { status(e.message); } };
  $('#tab-normal').onclick = () => switchTab('normal');
  $('#tab-log').onclick = () => switchTab('log');
  for (const name of ['normal', 'log']) $(`#tab-${name}`).addEventListener('keydown', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); switchTab(e.key === 'Home' ? 'normal' : e.key === 'End' ? 'log' : name === 'normal' ? 'log' : 'normal', true); }
  });
  $('#copy-log').onclick = () => {
    const t = state.timing || {};
    const summary = `表单预填助手 1.2.3\n计划：${clock(state.target)}\n触发：${clock(t.triggerAt)}\n发出：${clock(t.requestAt)}\n响应：${clock(t.responseAt)}\n往返：${t.duration ?? '—'} ms\n状态：${state.phase || 'idle'}`;
    GM_setClipboard(summary + '\n\n' + logs.map(e => `${clock(e.at)} ${e.message}`).join('\n'), 'text');
    $('#copy-log').textContent = '已复制'; setTimeout(() => { $('#copy-log').textContent = '复制日志'; }, 1500);
  };
  $('#close').onclick = () => { $('#panel').hidden = true; $('#open').hidden = false; };
  $('#open').onclick = showPanel;
  $('#save').onclick = guard(() => { save(); status('预填已保存在本浏览器，尚未启动提交。'); });
  $('#scan').onclick = guard(async () => { if (schema) save(); await scan(); });
  $('#arm').onclick = guard(arm); $('#stop').onclick = () => cancel();
  $('#clear').onclick = () => {
    if (!confirm('请先核对腾讯网页的提交记录。清除本地记录不会撤销报名。确定清除本表预填和提交记录？')) return;
    release(); localStorage.removeItem(OWNERKEY); GM_deleteValue(KEY); GM_deleteValue(TASK);
    config = { values: {}, time: '' }; state = { phase: 'idle' }; if (schema) render(); status('本表本地内容已清除。'); $('#count').textContent = '尚未启动';
  };
  GM_registerMenuCommand('打开报名预填窗口', showPanel);
  window.addEventListener('pagehide', () => {
    const s = GM_getValue(TASK, {});
    if (s.phase === 'armed' && s.owner === OWNER) persist({ ...s, phase: 'cancelled', message: '页面已刷新或离开，定时已取消。预填保留，请重新核对并启动。' });
    release();
  });
  renderLogs(); guard(scan)(); setInterval(updateCountdown, 250);
  document.addEventListener('visibilitychange', () => {
    if (owned && state.phase === 'armed') {
      addLog(document.hidden ? '页面进入后台，浏览器可能延后计时' : '页面回到前台，重新检查定时');
      if (!document.hidden) { tick(); scheduleNext(); }
    }
  });
  window.addEventListener('pagehide', () => { if (logTimer) { clearTimeout(logTimer); logTimer = 0; GM_setValue(LOGKEY, logs); } });
})();

