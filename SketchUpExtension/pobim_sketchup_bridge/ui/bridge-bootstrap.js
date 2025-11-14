(function () {
  if (!window.__pobimPendingEvents) {
    window.__pobimPendingEvents = [];
  }

  if (!window.PobimSketchBridge) {
    window.PobimSketchBridge = {
      fromSketchUp(type, payload) {
        window.__pobimPendingEvents.push({ type, payload });
      }
    };
  }
})();

