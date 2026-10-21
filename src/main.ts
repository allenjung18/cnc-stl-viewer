import { DEFAULT_PROFILE } from './state/profiles';
import { buildScene } from './view/scene';
import { Viewport } from './view/viewport';

const container = document.getElementById('viewport');
if (!container) throw new Error('missing #viewport element');

const machine = buildScene(DEFAULT_PROFILE);
const viewport = new Viewport(container, machine.scene, machine.bounds.travel);

if (import.meta.env.DEV) {
  // Read-only handle for the browser smoke test; not present in a production build.
  (window as unknown as { __stlViewer: unknown }).__stlViewer = { machine, viewport };
}
