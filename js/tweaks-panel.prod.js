// Production stand-in for js/tweaks-panel.babel: the real file is a design-tool
// edit-mode overlay (postMessage protocol with a host iframe) that never
// activates on the live site, so shipping its ~25KB to every visitor was pure
// dead weight. This keeps just the bit App() actually needs: local state for
// the palette/photo tweak values, with no UI and no host handshake.
function useTweaks(defaults) {
  var s = React.useState(defaults);
  var t = s[0], setT = s[1];
  var setTweak = React.useCallback(function (key, value) {
    setT(function (prev) {
      var next = Object.assign({}, prev);
      next[key] = value;
      return next;
    });
  }, []);
  return [t, setTweak];
}
function TweaksPanel() { return null; }
function TweakSection() { return null; }
function TweakSelect() { return null; }
Object.assign(window, { useTweaks: useTweaks, TweaksPanel: TweaksPanel, TweakSection: TweakSection, TweakSelect: TweakSelect });
