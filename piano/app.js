import van from 'vanjs-core';
const { header, main, h1, div } = van.tags;

const heard = van.state(null);

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteName(midi){
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
function freqToMidi(freq){
    return Math.round(69 + 12 * Math.log2(freq / 440));
}
let audioCtx = null;
function ensureAudio(){
    if(!audioCtx){
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
    }
    if(audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}
function synthSource(ctx, spec){
    const midis = spec.split(',').filter(s => s !== '').map(Number);
    const mix = ctx.createGain();
    for(const m of midis){
        const osc = ctx.createOscillator();
        osc.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
        osc.connect(mix);
        osc.start();
    }
    return mix;
}
const FFT_SIZE = 8192;
function startListening(synthSpec){
    const ctx = ensureAudio();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    synthSource(ctx, synthSpec).connect(analyser);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    analyser.connect(mute);
    mute.connect(ctx.destination);
    listen(analyser);
}
const FLOOR_DB = -80;
function detect(analyser){
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const hzPerBin = audioCtx.sampleRate / analyser.fftSize;
    let peak = -Infinity, peakBin = -1;
    for(let i = 1; i < bins.length; i++){
        if(bins[i] > peak){ peak = bins[i]; peakBin = i; }
    }
    if(peak < FLOOR_DB) return null;
    return noteName(freqToMidi(peakBin * hzPerBin));
}
function listen(analyser){
    (function tick(){
        heard.val = detect(analyser);
        requestAnimationFrame(tick);
    })();
}

function Readout(){
    return div({ class: 'readout' }, () => heard.val ?? '—');
}

function App(){
    return [
        header({ class: 'app-bar' }, h1('Piano hero')),
        main({ class: 'screen' }, Readout(), Targets()),
    ];
}

van.add(document.getElementById('app'), App());
document.getElementById('loading')?.remove();
const synth = new URLSearchParams(location.search).get('synth');
if(synth !== null) startListening(synth);
