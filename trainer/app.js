const CONFIG_KEY = 'karate-trainer.config';
const DEFAULTS = { count: 10, min: 3, max: 10 };

function loadConfig(){
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if(raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch(_){}
    return { ...DEFAULTS };
}

function saveConfig(config){
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch(_){}
}
function setConfigField(field, value){
    const config = { ...state.config, [field]: value };
    saveConfig(config);
    setState({ config, configError: '' });
}
function validateConfig(c){
    if(!(c.count >= 1)) return 'Number of beeps must be at least 1.';
    if(!(c.min > 0)) return 'Minimum delay must be greater than 0.';
    if(!(c.max >= c.min)) return 'Maximum delay must be at least the minimum.';
    return '';
}

const state = { config: null, configError: '', session: null };

function setState(updates){
    Object.assign(state, updates);
    renderApp();
}

let audioCtx = null;

function ensureAudio(){
    try {
        if(!audioCtx){
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if(!Ctx) return null;
            audioCtx = new Ctx();
        }
        if(audioCtx.state === 'suspended') audioCtx.resume();
    } catch(_){ audioCtx = null; }
    return audioCtx;
}
function beep(){
    const ctx = ensureAudio();
    if(!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.start(t);
        osc.stop(t + 0.2);
    } catch(_){}
}
function flash(){
    const el = document.getElementById('flash');
    if(!el) return;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
    el.addEventListener('animationend', () => el.classList.remove('on'), { once: true });
}

function startSession(){
    const error = validateConfig(state.config);
    if(error){ setState({ configError: error }); return; }
    ensureAudio();
    state.session = { running: true, done: 0, total: state.config.count, gaps: [], timer: null };
    document.body.setAttribute('data-running', '1');
    renderApp();
    scheduleNext();
}
function scheduleNext(){
    const s = state.session;
    if(!s || !s.running) return;
    if(s.done >= s.total){ finishSession(); return; }
    const gap = randomGap(state.config.min, state.config.max);
    s.timer = setTimeout(() => {
        if(!state.session || !state.session.running) return;
        beep();
        flash();
        state.session.done++;
        state.session.gaps.push(gap);
        renderApp();
        scheduleNext();
    }, gap);
}
function finishSession(){
    if(state.session) state.session.running = false;
    document.body.setAttribute('data-running', '0');
    renderApp();
}
function randomGap(minSeconds, maxSeconds){
    const lo = minSeconds * 1000, hi = maxSeconds * 1000;
    return Math.round(lo + Math.random() * (hi - lo));
}
function stopSession(){
    const s = state.session;
    if(s && s.timer) clearTimeout(s.timer);
    if(s) s.running = false;
    document.body.setAttribute('data-running', '0');
    renderApp();
}

class AppRoot extends LitElement {
    createRenderRoot(){ return this; }
    render(){ return appTemplate(); }
}
customElements.define('app-root', AppRoot);
function appTemplate(){
    return html`
      <header class="app-bar"><h1>Karate beep trainer</h1></header>
      <main class="screen">
        ${state.session && state.session.running ? runningView() : idleView()}
      </main>
    `;
}
function idleView(){
    const c = state.config || DEFAULTS;
    const last = state.session && !state.session.running && state.session.done > 0
        ? state.session : null;
    return html`
      <form class="config" @submit=${e => { e.preventDefault(); startSession(); }}>
        <label>Number of beeps
          <input type="number" min="1" step="1" .value=${String(c.count)}
                 @input=${e => setConfigField('count', parseInt(e.target.value || '0', 10))}>
        </label>
        <label>Minimum delay (s)
          <input type="number" min="0" step="0.5" .value=${String(c.min)}
                 @input=${e => setConfigField('min', parseFloat(e.target.value || '0'))}>
        </label>
        <label>Maximum delay (s)
          <input type="number" min="0" step="0.5" .value=${String(c.max)}
                 @input=${e => setConfigField('max', parseFloat(e.target.value || '0'))}>
        </label>
        ${state.configError ? html`<p class="error" role="alert">${state.configError}</p>` : ''}
        <button type="submit" class="primary">Start</button>
      </form>
      ${last ? sessionSummary(last) : ''}
    `;
}
function runningView(){
    const s = state.session;
    return html`
      <div class="run">
        <p class="hint">Listen — punch on the beep.</p>
        <div class="count" role="status">${s.done} / ${s.total}</div>
        <button class="danger" @click=${() => stopSession()}>Stop</button>
        ${gapList(s)}
      </div>
    `;
}
function gapList(s){
    return html`
      <ul class="gaps" aria-label="Delays before each beep">
        ${s.gaps.map((ms, i) => html`
          <li class="gap" data-ms=${ms}>${i + 1}. ${(ms / 1000).toFixed(1)}s</li>
        `)}
      </ul>
    `;
}
function sessionSummary(s){
    return html`
      <section class="summary">
        <h2>Last session</h2>
        <p>${s.done} beep${s.done > 1 ? 's' : ''}.</p>
        ${gapList(s)}
      </section>
    `;
}

import { html, LitElement } from 'lit';

const appRootEl = document.querySelector('app-root');
function renderApp(){ appRootEl?.requestUpdate(); }

state.config = loadConfig();
renderApp();
document.body.setAttribute('data-app-ready', '1');
