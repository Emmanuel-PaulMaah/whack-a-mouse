import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { XRButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRButton.js';

let renderer, scene, camera, clock;
let xrRefSpace, xrViewerSpace, hitTestSource = null;

let reticle;
let gridRoot;           // group anchored to the placed plane
let placed = false;
let paused = false;

const holes = [];       // meshes for hole visuals (discs)
const GRID = 3;
const SPACING = 0.38;   // meters between holes (tweak for your space)
const HOLE_RADIUS = 0.10;

let mole;               // single reusable mole mesh
let moleState = 'down'; // 'up' | 'down'
let activeHoleIndex = -1;
let nextPopAt = 0;
let score = 0;
let streak = 0;

const POP_INTERVAL_MIN = 700;   // ms between pops
const POP_INTERVAL_MAX = 1400;
const UP_DURATION = 900;        // ms mole stays up if not whacked
let upSince = 0;

// UI
const $score = document.getElementById('score');
const $streak = document.getElementById('streak');
const $status = document.getElementById('status');
const $btnReset = document.getElementById('reset');
const $btnPause = document.getElementById('pause');

init();

function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333366, 1.0));
  scene.fog = new THREE.FogExp2(0x000000, 0.14);

  // reticle
  reticle = makeReticle();
  reticle.visible = false;
  scene.add(reticle);

  // grid root (not visible until placed)
  gridRoot = new THREE.Group();
  gridRoot.name = 'gridRoot';
  scene.add(gridRoot);

  // mole (reused)
  mole = makeMole();
  mole.visible = false;
  scene.add(mole);

  // events
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', onResize);
  $btnReset.addEventListener('click', resetGame);
  $btnPause.addEventListener('click', () => { paused = !paused; $btnPause.textContent = paused ? 'resume' : 'pause'; });

  // XR button
  document.body.appendChild(XRButton.createButton(renderer, {
    requiredFeatures: ['hit-test', 'local-floor'],
    optionalFeatures: []
  }));

  // XR session setup
  renderer.xr.addEventListener('sessionstart', async () => {
    const session = renderer.xr.getSession();
    xrRefSpace = await session.requestReferenceSpace('local-floor');
    xrViewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: xrViewerSpace });
    clock = new THREE.Clock();
    scheduleNextPop(performance.now());
  });

  renderer.xr.addEventListener('sessionend', () => {
    hitTestSource = null;
    placed = false;
    clearGrid();
    mole.visible = false;
    moleState = 'down';
    $status.textContent = 'find a floor, then tap to place the grid.';
  });

  // start loop
  renderer.setAnimationLoop(onXRFrame);

  window.__app = { THREE, scene, renderer, camera, reticle, gridRoot, mole, holes };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onXRFrame(time, frame) {
  const dt = clock ? clock.getDelta() : 0.016;

  // reticle via hit-test
  updateReticle(frame);

  if (!paused && placed) {
    updateMole(time, dt);
  }

  renderer.render(scene, camera);
}

function updateReticle(frame) {
  if (!hitTestSource || !frame) {
    reticle.visible = false;
    return;
  }
  const hits = frame.getHitTestResults(hitTestSource);
  if (hits.length) {
    const pose = hits[0].getPose(xrRefSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
      if (!placed) $status.textContent = 'tap to place the grid.';
    } else {
      reticle.visible = false;
    }
  } else {
    reticle.visible = false;
    if (!placed) $status.textContent = 'move phone to help it find the floor…';
  }
}

function onPointerDown(e) {
  if (!placed) {
    // place grid at reticle pose, or fallback in front
    if (reticle.visible) {
      gridRoot.position.copy(reticle.position);
      gridRoot.quaternion.copy(reticle.quaternion);
    } else {
      const xrCam = renderer.xr.getCamera(camera);
      const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
      const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(xrCam.quaternion);
      gridRoot.position.copy(origin).addScaledVector(fwd.normalize(), 1.5);
      gridRoot.position.y -= 0.8; // rough floor guess
    }
    buildGrid();
    placed = true;
    $status.textContent = 'whack the mole when it pops!';
    scheduleNextPop(performance.now());
    return;
  }

  // raycast for mole hits
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), renderer.xr.getCamera(camera));
  const hit = raycaster.intersectObject(mole, true)[0];
  if (hit && moleState === 'up') whackMole();
}

// ---- grid / holes ---------------------------------------------------------

function buildGrid() {
  clearGrid();
  // build 3x3 at SPACING centered on gridRoot
  const offset = (GRID - 1) * SPACING * 0.5;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const hole = makeHole();
      hole.position.set((c * SPACING) - offset, 0, (r * SPACING) - offset);
      hole.position.applyQuaternion(gridRoot.quaternion);
      hole.position.add(gridRoot.position);
      holes.push(hole);
      scene.add(hole);
    }
  }
}

function clearGrid() {
  for (const h of holes) scene.remove(h);
  holes.length = 0;
}

function makeHole() {
  // dark disc + thin ring to suggest a hole
  const g1 = new THREE.CircleGeometry(HOLE_RADIUS, 32);
  const m1 = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.9 });
  const disc = new THREE.Mesh(g1, m1);
  disc.rotation.x = -Math.PI / 2;

  const g2 = new THREE.RingGeometry(HOLE_RADIUS * 0.82, HOLE_RADIUS * 1.02, 32);
  const m2 = new THREE.MeshBasicMaterial({ color: 0x333333 });
  const ring = new THREE.Mesh(g2, m2);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.001;

  const group = new THREE.Group();
  group.add(disc, ring);
  return group;
}

// ---- mole logic -----------------------------------------------------------

function makeMole() {
  // simple capsule-like character with eyes
  const group = new THREE.Group();
  const bodyGeo = new THREE.CapsuleGeometry(0.09, 0.06, 6, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8d5a3b, roughness: 0.7, metalness: 0.0 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.09;
  group.add(body);

  const eyeGeo = new THREE.SphereGeometry(0.015, 10, 10);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.03, 0.13, 0.06);
  const eyeR = eyeL.clone(); eyeR.position.x *= -1;
  group.add(eyeL, eyeR);

  group.userData.type = 'mole';
  return group;
}

function scheduleNextPop(now) {
  nextPopAt = now + rand(POP_INTERVAL_MIN, POP_INTERVAL_MAX);
}

function updateMole(nowMs, dt) {
  // if mole is down and it's time, pop it at a random hole
  if (moleState === 'down' && nowMs >= nextPopAt && holes.length) {
    activeHoleIndex = Math.floor(Math.random() * holes.length);
    const hole = holes[activeHoleIndex];

    // place mole so its base is at the hole center
    mole.position.copy(hole.position);
    mole.quaternion.copy(gridRoot.quaternion);
    mole.visible = true;

    // animate up
    mole.userData.anim = { kind: 'pop', t0: nowMs, dur: 180, from: -0.02, to: 0.16 };
    mole.position.y = hole.position.y + mole.userData.anim.from;
    moleState = 'up';
    upSince = nowMs;
  }

  // handle animations
  if (mole.visible && mole.userData.anim) {
    const { t0, dur, from, to, kind } = mole.userData.anim;
    const t = Math.min(1, (nowMs - t0) / dur);
    const y = from + (to - from) * easeOut(t);
    mole.position.y = holes[activeHoleIndex].position.y + y;

    if (t >= 1) {
      if (kind === 'pop') {
        mole.userData.anim = null;
      } else if (kind === 'hide' || kind === 'bonk') {
        mole.visible = false;
        mole.userData.anim = null;
        moleState = 'down';
        scheduleNextPop(nowMs);
      }
    }
  }

  // auto-hide if not whacked in time
  if (moleState === 'up' && nowMs - upSince > UP_DURATION && !mole.userData.anim) {
    // animate down
    mole.userData.anim = { kind: 'hide', t0: nowMs, dur: 160, from: 0.16, to: -0.02 };
    // streak reset on miss (don’t be harsh: no negative)
    streak = 0;
    updateHUD();
  }
}

function whackMole() {
  if (moleState !== 'up') return;
  moleState = 'down'; // prevent double hits
  const now = performance.now();
  // quick bonk animation: scale + flash emissive on body
  const body = mole.children[0];
  const startEm = body.material.emissive.getHex();
  const start = now, dur = 150;

  function tween() {
    const t = Math.min(1, (performance.now() - start) / dur);
    const s = 1 + 0.6 * (1 - (1 - t) * (1 - t));
    mole.scale.setScalar(s);
    body.material.emissive.setHex(0x442200);
    if (t < 1) requestAnimationFrame(tween);
    else {
      mole.scale.setScalar(1);
      body.material.emissive.setHex(startEm);
    }
  }
  tween();

  // animate down
  mole.userData.anim = { kind: 'bonk', t0: now, dur: 140, from: 0.16, to: -0.02 };

  // scoring
  score += 1;
  streak += 1;
  updateHUD();
}

// ---- utilities ------------------------------------------------------------

function resetGame() {
  score = 0;
  streak = 0;
  placed = false;
  paused = false;
  $btnPause.textContent = 'pause';
  $status.textContent = 'find a floor, then tap to place the grid.';
  mole.visible = false;
  mole.userData.anim = null;
  moleState = 'down';
  clearGrid();
  updateHUD();
}

function updateHUD() {
  $score.textContent = String(score);
  $streak.textContent = String(streak);
}

function easeOut(t){ return 1 - Math.pow(1 - t, 3); }
function rand(a,b){ return a + Math.random()*(b-a); }

// visuals
function makeReticle() {
  const g1 = new THREE.RingGeometry(0.06, 0.075, 48);
  const m1 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ring = new THREE.Mesh(g1, m1);
  ring.rotation.x = -Math.PI/2;

  const g2 = new THREE.CircleGeometry(0.006, 16);
  const m2 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const dot = new THREE.Mesh(g2, m2);
  dot.position.y = 0.001; dot.rotation.x = -Math.PI/2;

  const group = new THREE.Group();
  group.add(ring, dot);
  return group;
}
