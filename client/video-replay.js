import { Replayer } from 'rrweb';
window.startVideoReplay = (events) => {
  const replayer = new Replayer(events, {
    root: document.body,
    showWarning: false,
    showDebug: false,
    loadTimeout: 0,
    skipInactive: false,
    mouseTail: false,
    UNSAFE_replayCanvas: false,
    pauseAnimation: false,
    insertStyleRules: ['* { caret-color: transparent !important; }'],
  });
  // rrweb rebuilds the page into an iframe without allow-scripts.
  replayer.play(0);
  window.videoReplayer = replayer;
};
