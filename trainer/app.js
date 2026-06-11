import van from 'vanjs-core';
const { header, main, h1, h2, p, div, section, form, label, input, button, ul, li } = van.tags;

const CONFIG_KEY = 'karate-trainer.config';
const DEFAULTS = { count: 10, min: 3, max: 10 };

function loadConfig(){
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if(raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch(_){}
    return { ...DEFAULTS };
}

function saveConfig(){
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch(_){}
}
function setConfigField(field, value){
    config[field] = value;
    saveConfig();
    configError.val = validateConfig(config);
}
function validateConfig(c){
    if(!(c.count >= 1)) return 'Number of beeps must be at least 1.';
    if(!(c.min > 0)) return 'Minimum delay must be greater than 0.';
    if(!(c.max >= c.min)) return 'Maximum delay must be at least the minimum.';
    return '';
}

const config = loadConfig();

const configError = van.state('');
const session = van.state(null);

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
    const error = validateConfig(config);
    if(error){ configError.val = error; return; }
    ensureAudio();
    session.val = { running: true, done: 0, total: config.count, gaps: [], timer: null };
    document.body.setAttribute('data-running', '1');
    scheduleNext();
}
function scheduleNext(){
    const s = session.val;
    if(!s || !s.running) return;
    if(s.done >= s.total){ finishSession(); return; }
    const gap = randomGap(config.min, config.max);
    s.timer = setTimeout(() => {
        const cur = session.val;
        if(!cur || !cur.running) return;
        beep();
        flash();
        session.val = { ...cur, done: cur.done + 1, gaps: [...cur.gaps, gap] };
        scheduleNext();
    }, gap);
}
function finishSession(){
    const s = session.val;
    if(s) session.val = { ...s, running: false };
    document.body.setAttribute('data-running', '0');
}
function randomGap(minSeconds, maxSeconds){
    const lo = minSeconds * 1000, hi = maxSeconds * 1000;
    return Math.round(lo + Math.random() * (hi - lo));
}
function stopSession(){
    const s = session.val;
    if(s && s.timer) clearTimeout(s.timer);
    if(s) session.val = { ...s, running: false };
    document.body.setAttribute('data-running', '0');
}

function App(){
    return [
        header({ class: 'app-bar' }, h1('Karate beep trainer')),
        main({ class: 'screen' },
            () => session.val && session.val.running ? RunningView() : IdleView()),
    ];
}
function IdleView(){
    const c = config;
    const s = session.val;
    const last = s && !s.running && s.done > 0 ? s : null;
    return div(
        form({ class: 'config', novalidate: true,
               onsubmit: e => { e.preventDefault(); startSession(); } },
            label('Number of beeps',
                input({ type: 'number', min: '1', step: '1', value: c.count,
                        oninput: e => setConfigField('count', parseInt(e.target.value || '0', 10)) })),
            label('Minimum delay (s)',
                input({ type: 'number', min: '0', step: 'any', value: c.min,
                        oninput: e => setConfigField('min', parseFloat(e.target.value || '0')) })),
            label('Maximum delay (s)',
                input({ type: 'number', min: '0', step: 'any', value: c.max,
                        oninput: e => setConfigField('max', parseFloat(e.target.value || '0')) })),
            () => configError.val ? p({ class: 'error', role: 'alert' }, configError.val) : '',
            button({ type: 'submit', class: 'primary' }, 'Start'),
        ),
        last ? sessionSummary(last) : '',
    );
}
function RunningView(){
    const s = session.val;
    return div({ class: 'run' },
        p({ class: 'hint' }, 'Listen — punch on the beep.'),
        div({ class: 'count', role: 'status' }, `${s.done} / ${s.total}`),
        button({ class: 'danger', onclick: () => stopSession() }, 'Stop'),
        gapList(s),
    );
}
function gapList(s){
    return ul({ class: 'gaps', 'aria-label': 'Delays before each beep' },
        s.gaps.map((ms, i) =>
            li({ class: 'gap', 'data-ms': ms }, `${i + 1}. ${(ms / 1000).toFixed(1)}s`)));
}
function sessionSummary(s){
    return section({ class: 'summary' },
        h2('Last session'),
        p(`${s.done} beep${s.done > 1 ? 's' : ''}.`),
        gapList(s));
}

const DEMO = new URLSearchParams(location.search).get('demo');
if(DEMO === 'error')
    configError.val = 'Maximum delay must be at least the minimum.';
else if(DEMO === 'running' || DEMO === 'flash')
    session.val = { running:true, done:3, total:10, gaps:[5200,7800,4100], timer:null };
else if(DEMO === 'summary')
    session.val = { running:false, done:10, total:10, timer:null,
                    gaps:[5200,7800,4100,6300,9100,3400,8800,4700,7200,5900] };
if(DEMO !== 'loading'){
    van.add(document.getElementById('app'), App());
    document.body.setAttribute('data-app-ready', '1');
}
if(DEMO === 'flash'){
    const f = document.getElementById('flash');
    if(f){ f.style.animation = 'none'; f.style.opacity = '0.85'; }
}
