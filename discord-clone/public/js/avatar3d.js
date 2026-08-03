// avatar3d.js - 3D MMD avatar renderer for voice-chat tiles.
//
// This is a trimmed-down, multi-instance version of the standalone
// avatar.js example: instead of one big scene with OrbitControls, each
// voice-tile gets its own small self-contained instance (own scene, camera,
// renderer, render loop) sized to fill whatever container it's given -
// namely the 96x96 circular ring in a .voice-tile.
//
// Exposed as window.Avatar3D so the rest of the app (plain <script> files,
// no bundler) can call it without import syntax.

import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Shared cursor position, tracked once for the whole page rather than once
// per avatar instance (there can be many - every voice tile plus the Edit
// Profile preview). Each instance reads from this to figure out where its
// own head/eye bones should turn to "look" toward the cursor, based on the
// cursor's position relative to that instance's own container on screen.
const sharedCursor = { x: -9999, y: -9999 };
let cursorTrackingAttached = false;
function ensureCursorTracking() {
    if (cursorTrackingAttached) return;
    cursorTrackingAttached = true;
    window.addEventListener('mousemove', (e) => {
        sharedCursor.x = e.clientX;
        sharedCursor.y = e.clientY;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) {
            sharedCursor.x = e.touches[0].clientX;
            sharedCursor.y = e.touches[0].clientY;
        }
    }, { passive: true });
}

function createAvatar3D(container, options = {}) {
    const {
        modelUrl,
        onReady = () => {},
        onError = () => {},
        // Interactive drag-to-rotate, right-drag/two-finger-to-pan,
        // scroll/pinch-to-zoom framing. Off by default: the voice-chat
        // tiles are tiny 96x96 rings and shouldn't eat mouse input from the
        // rest of the UI. Turn on for the Edit Profile preview so the user
        // can frame their model.
        controls: controlsEnabled = false,
        // Decorative idle sway - only makes sense when nobody's manually
        // framing the shot. Defaults to whatever controls isn't doing.
        autoRotate: autoRotateEnabled = !controlsEnabled,
        // Saved framing: zoom is a camera-distance multiplier (1 = default,
        // <1 = closer/bigger, >1 = further/smaller); offsetX/offsetY pan the
        // framing target left/right/up/down in world units; rotationY spins
        // the model horizontally (radians) so a different side faces the
        // camera. Vertical tilt is intentionally not exposed. These are what
        // gets persisted to the user's profile so every place the model
        // renders (voice tiles, other people's screens) uses the same crop
        // the user chose in Edit Profile.
        zoom: initialZoom = 1,
        offsetX: initialOffsetX = 0,
        offsetY: initialOffsetY = 0,
        rotationY: initialRotationY = 0,
        // Fired whenever the user finishes a drag/scroll gesture (controls
        // must be enabled), with the resulting { zoom, offsetX, offsetY, rotationY } -
        // so the caller can save it.
        onFramingChange = () => {},
        // Lip-sync tuning, saved to the user's profile alongside framing so
        // it's consistent everywhere the model renders. mouthIntensity is
        // how far the mouth shape key opens at most (0-1). voiceStart/
        // voiceMax are the input-volume window (0-100, same RMS-ish scale
        // voice.js's speaking meter uses) the mouth ramps open across:
        // below voiceStart it stays closed, at/above voiceMax it's fully
        // open (capped by mouthIntensity).
        mouthIntensity: initialMouthIntensity = 0.5,
        voiceStart: initialVoiceStart = 5,
        voiceMax: initialVoiceMax = 59,
        // Blink tuning, saved alongside the above. blinkIntensity is how
        // closed the eye shape key gets at the peak of a blink (0-1, same
        // "cap the value" idea as mouthIntensity). blinkIntervalMin/Max are
        // the random range (seconds) between blinks - a new random wait in
        // that range is picked after each blink finishes. blinkEnabled is
        // the initial on/off state (also toggleable live via toggleBlink()).
        blinkIntensity: initialBlinkIntensity = 1,
        blinkIntervalMin: initialBlinkIntervalMin = 2,
        blinkIntervalMax: initialBlinkIntervalMax = 4,
        blinkEnabled: initialBlinkEnabled = true,
        // Head/eye tracking: turns toward wherever the cursor currently is
        // on screen (not just over this instance's own container), same
        // "portrait that watches you" idea. On by default; toggleable live
        // via setLookAtCursor(). Falls back to a no-op if the loaded model
        // doesn't have recognizable head/neck/eye bones.
        lookAtCursor: initialLookAtCursor = true,
        // Optional manual override for which shape key(s) drive blinking.
        // By default (empty) the built-in name-guessing in findShapeKeys()
        // is used ('blink', 'eye', 目, etc.) - but plenty of models use
        // shape key names that don't match any of those, so this lets the
        // user type the exact name(s) themselves (comma-separated) in Edit
        // Profile instead of blinking never triggering. Accepts either a
        // comma-separated string (as saved to the profile) or an array.
        blinkShapeKeys: initialBlinkShapeKeys = '',
        // Optional manual override for which shape key(s) drive the
        // mouse-hold surprise expression. Empty means no explicit override,
        // which falls back to the built-in name-guessing in findShapeKeys()
        // for the same reason as blinkShapeKeys above.
        surpriseShapeKeys: initialSurpriseShapeKeys = '',
        // Same idea as blinkShapeKeys above, but for which shape key(s)
        // drive the mouth-opening lip-sync animation. By default (empty)
        // the built-in name-guessing in findShapeKeys() is used ('あ',
        // 'mouth', 'open', etc.) - but plenty of models use shape key
        // names that don't match any of those, so this lets the user type
        // the exact name(s) themselves (comma-separated) in Edit Profile
        // instead of lip sync never triggering. Accepts either a
        // comma-separated string (as saved to the profile) or an array.
        mouthShapeKeys: initialMouthShapeKeys = '',
    } = options;

    function parseShapeKeyNames(v) {
        if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
        if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
        return [];
    }

    function parseSurpriseShapeKeySettings(v) {
        const normalizeEntry = (entry) => {
            if (!entry) return null;
            if (typeof entry === 'string') {
                const name = entry.trim();
                return name ? { name, intensity: 1 } : null;
            }
            if (typeof entry === 'object') {
                const name = String(entry.name || '').trim();
                if (!name) return null;
                const intensity = Number(entry.intensity);
                return {
                    name,
                    intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1,
                };
            }
            return null;
        };

        if (Array.isArray(v)) {
            return v.map(normalizeEntry).filter(Boolean);
        }
        if (typeof v === 'string') {
            const trimmed = v.trim();
            if (!trimmed) return [];
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map(normalizeEntry).filter(Boolean);
                }
            } catch (e) {
                // Fall back to the legacy comma-separated single-entry format.
            }
            const names = parseShapeKeyNames(trimmed);
            return names.map((name) => ({ name, intensity: 1 }));
        }
        if (v && typeof v === 'object' && Array.isArray(v.entries)) {
            return v.entries.map(normalizeEntry).filter(Boolean);
        }
        return [];
    }

    let blinkShapeKeyNames = parseShapeKeyNames(initialBlinkShapeKeys);
    let mouthShapeKeyNames = parseShapeKeyNames(initialMouthShapeKeys);
    let surpriseShapeKeySettings = parseSurpriseShapeKeySettings(initialSurpriseShapeKeys);

    // Same clamp ranges as the server (server/routes/auth.js).
    const MOUTH_INTENSITY_MIN = 0, MOUTH_INTENSITY_MAX = 1;
    const VOICE_THRESHOLD_MIN = 0, VOICE_THRESHOLD_MAX = 100;
    const BLINK_INTENSITY_MIN = 0, BLINK_INTENSITY_MAX = 1;
    const BLINK_INTERVAL_MIN = 0.2, BLINK_INTERVAL_MAX = 20;

    function clampMouthIntensity(v) {
        return Math.min(MOUTH_INTENSITY_MAX, Math.max(MOUTH_INTENSITY_MIN, v));
    }
    function clampVoiceThreshold(v) {
        return Math.min(VOICE_THRESHOLD_MAX, Math.max(VOICE_THRESHOLD_MIN, v));
    }
    function clampBlinkIntensity(v) {
        return Math.min(BLINK_INTENSITY_MAX, Math.max(BLINK_INTENSITY_MIN, v));
    }
    function clampBlinkInterval(v) {
        return Math.min(BLINK_INTERVAL_MAX, Math.max(BLINK_INTERVAL_MIN, v));
    }

    // Update CONFIG in createAvatar3D
    // In createAvatar3D, update CONFIG:
    const CONFIG = {
        startThreshold: clampVoiceThreshold(initialVoiceStart),
        maxThreshold: clampVoiceThreshold(initialVoiceMax),
        mouthLimit: clampMouthIntensity(initialMouthIntensity),
        blinkIntensity: clampBlinkIntensity(initialBlinkIntensity),
        blinkIntervalMin: clampBlinkInterval(initialBlinkIntervalMin),
        blinkIntervalMax: clampBlinkInterval(initialBlinkIntervalMax),
        cameraPosition: options.cameraPosition || [0, 1.0, 2.5], // Closer
        cameraTarget: options.cameraTarget || [0, 0.5, 0],
        modelPosition: options.modelPosition || [0, -0.5, 0],
        autoRotateSpeed: 0,
        // How far the head/neck/eyes turn at most (radians) when the
        // cursor is at the screen edge. Eyes move further than the head,
        // same as real gaze behavior - a small glance is mostly eyes, a
        // big one brings the head along too. Neck follows the head at a
        // fraction of its angle so the turn looks like one smooth motion
        // rather than a hinge at the collar.
        headYawMax: 0.35,
        headPitchMax: 0.15,
        neckFollow: 0.4,
        eyeYawMax: 0.5,
        eyePitchMax: 0.3,
        idleHeadYawAmplitude: 0.04,
        idleHeadPitchAmplitude: 0.025,
        idleEyeYawAmplitude: 0.03,
        idleEyePitchAmplitude: 0.015,
        idleBodySwayAmplitude: 0.02,
        idleBodyBobAmplitude: 0.015,
        idleBodyTiltAmplitude: 0.03,
    };

    // Same clamp range as the server (server/routes/auth.js) so what the
    // user sees while dragging matches what will actually be saved.
    const ZOOM_MIN = 0.3, ZOOM_MAX = 3, OFFSET_MAX = 2;
    let zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, initialZoom));
    let offsetX = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, initialOffsetX));
    let offsetY = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, initialOffsetY));
    let rotationY = initialRotationY;
    let baseTarget, baseDistance, baseDirection, baseAzimuth, basePolar;

    let scene, camera, renderer, controls;
    let model = null;
    let mouthKeys = [];
    let blinkKeys = [];
    let surpriseKeyGroups = [];
    let targetMouth = 0;
    let surpriseAmount = 0;
    let mouseIsHeld = false;
    let isBlinking = false;
    let blinkTimer = 0;
    let isBlinkEnabled = initialBlinkEnabled;
    let isReady = false;
    let disposed = false;
    let rafId = null;
    let lastTime = performance.now();
    let idleTime = 0;

    // Gaze tracking state. Bones are looked up once after the model loads
    // (null if the model doesn't have a recognizable one - tracking just
    // no-ops for whichever bones are missing). bindEuler captures each
    // bone's rest rotation so the gaze offset is applied additively rather
    // than overwriting whatever pose the model started in. current*
    // values are lerped toward the cursor-derived target each frame so the
    // motion is a smooth turn rather than snapping.
    let isLookAtCursorEnabled = initialLookAtCursor;
    let headBone = null, neckBone = null, eyeLBone = null, eyeRBone = null, upperBodyBone = null;
    let headBind = null, neckBind = null, eyeLBind = null, eyeRBind = null, upperBodyBind = null;
    let currentHeadYaw = 0, currentHeadPitch = 0, currentEyeYaw = 0, currentEyePitch = 0, currentUpperBodyYaw = 0, currentUpperBodyPitch = 0;
    // When set (via setRemoteGaze), overrides the local-cursor computation
    // below - used for other participants' voice tiles, which display
    // where *that person* is looking rather than tracking this browser's
    // own cursor. lastCursorDX/DY mirror whatever direction this instance
    // computed locally (only non-zero when isLookAtCursorEnabled is on),
    // so the local user's own tile can read it back out via
    // getGazeDirection() and broadcast it to everyone else.
    let remoteGazeDX = null, remoteGazeDY = null;
    let lastCursorDX = 0, lastCursorDY = 0;

    function applyFraming() {
        // target = base target, panned by the saved/dragged offset
        const target = new THREE.Vector3(
            baseTarget.x + offsetX,
            baseTarget.y + offsetY,
            baseTarget.z
        );
        const offset = new THREE.Vector3().setFromSphericalCoords(
            baseDistance * zoom,
            basePolar,
            baseAzimuth + rotationY
        );
        camera.position.copy(target).add(offset);
        camera.lookAt(target);
        if (controls) controls.target.copy(target);
    }

    function initScene() {
        const width = container.clientWidth || 96;
        const height = container.clientHeight || 96;

        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 50);

        // Base (unzoomed/uncentered/unrotated) camera rig, from CONFIG -
        // this used to be hardcoded here and CONFIG.cameraPosition/
        // cameraTarget were silently ignored, which is why passing a closer
        // cameraPosition never actually made the model bigger.
        const basePos = new THREE.Vector3(...CONFIG.cameraPosition);
        baseTarget = new THREE.Vector3(...CONFIG.cameraTarget);
        baseDirection = basePos.clone().sub(baseTarget);
        baseDistance = baseDirection.length() || 1;
        baseDirection.normalize();
        const baseSpherical = new THREE.Spherical().setFromVector3(baseDirection);
        baseAzimuth = baseSpherical.theta;
        basePolar = baseSpherical.phi;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        container.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = baseDistance * ZOOM_MIN;
        controls.maxDistance = baseDistance * ZOOM_MAX;

        // "Frame the shot" controls, only when explicitly enabled by the
        // caller (the Edit Profile preview turns this on; voice-chat tiles
        // leave it off): left-drag/one-finger to rotate (spin left/right to
        // pick which side faces the camera), right-drag/two-finger to pan
        // (reposition), scroll/pinch to zoom. Vertical tilt is locked (min
        // and max polar angle pinned to the base angle) so rotating can't
        // flip the camera upside-down or under the model.
        controls.enabled = controlsEnabled;
        controls.enableRotate = controlsEnabled;
        controls.enableZoom = controlsEnabled;
        controls.enablePan = controlsEnabled;
        controls.minPolarAngle = basePolar;
        controls.maxPolarAngle = basePolar;
        controls.screenSpacePanning = true;
        controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

        applyFraming();
        controls.update();

        if (controlsEnabled) {
            const emitFramingChange = () => {
                zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.position.distanceTo(controls.target) / baseDistance));
                offsetX = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, controls.target.x - baseTarget.x));
                offsetY = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, controls.target.y - baseTarget.y));
                rotationY = controls.getAzimuthalAngle() - baseAzimuth;
                onFramingChange({ zoom, offsetX, offsetY, rotationY });
            };
            // 'end' fires once when a drag/scroll gesture finishes - that's
            // the point to report the settled value back to the caller,
            // rather than spamming it on every intermediate frame.
            controls.addEventListener('end', emitFramingChange);
        }

        // Brighter lights to see the model
        const ambient = new THREE.AmbientLight(0xffffff, 0.8);
        scene.add(ambient);
        //const main = new THREE.DirectionalLight(0xffffff, 1.5);
        //main.position.set(2, 5, 3);
        //scene.add(main);
        //const fill = new THREE.DirectionalLight(0xaaccff, 0.8);
        //fill.position.set(-3, 2, 2);
        //scene.add(fill);

        // Add a grid helper to see the ground
        const gridHelper = new THREE.GridHelper(5, 10, 0x888888, 0x444444);
        scene.add(gridHelper);
    }

    function findShapeKeys(mesh, customBlinkNames, customMouthNames, customSurpriseEntries) {
        const defaultMouthNames = ['あ', 'い', 'う', 'え', 'お', 'a', 'i', 'u', 'e', 'o', 'mouth', 'open', '口', '開'];
        const defaultBlinkNames = ['blink', 'eye', '目', 'まばたき', 'closeeye', 'eyelid', 'wink'];
        const defaultSurpriseNames = ['surprise', 'surprised', 'shock', 'shocked', 'wow', 'びっくり', '驚', 'open', '目', '口'];
        // If the user typed in specific shape key name(s) to use, match only
        // those (still a case-insensitive "contains" match, same as the
        // default list) instead of guessing from the built-in name list.
        const blinkNames = (customBlinkNames && customBlinkNames.length) ? customBlinkNames : defaultBlinkNames;
        const mouthNames = (customMouthNames && customMouthNames.length) ? customMouthNames : defaultMouthNames;
        const surpriseNames = (customSurpriseEntries && customSurpriseEntries.length)
            ? customSurpriseEntries.map((entry) => entry.name).filter(Boolean)
            : defaultSurpriseNames;

        const foundMouth = [], foundBlink = [], foundSurprise = [];

        mesh.traverse((child) => {
            if (child.isMesh && child.morphTargetDictionary) {
                const dict = child.morphTargetDictionary;
                const inf = child.morphTargetInfluences;
                Object.keys(dict).forEach((key) => {
                    const lower = key.toLowerCase();
                    if (mouthNames.some((n) => lower.includes(n.toLowerCase()))) {
                        foundMouth.push({ index: dict[key], inf });
                    }
                    if (blinkNames.some((n) => lower.includes(n.toLowerCase()))) {
                        foundBlink.push({ index: dict[key], inf });
                    }
                    if (surpriseNames.some((n) => lower.includes(n.toLowerCase()))) {
                        foundSurprise.push({ index: dict[key], inf });
                    }
                });
            }
        });

        return { mouthKeys: foundMouth, blinkKeys: foundBlink, surpriseKeys: foundSurprise };
    }

    // Every shape key name found on the loaded model, deduped, in whatever
    // order the model defines them - used by Edit Profile to show the user
    // what's actually available to type into the blink-shape-key field,
    // since MMD models frequently use Japanese names that aren't guessable.
    function collectShapeKeyNames(mesh) {
        const names = [];
        const seen = new Set();
        if (!mesh) return names;
        mesh.traverse((child) => {
            if (child.isMesh && child.morphTargetDictionary) {
                Object.keys(child.morphTargetDictionary).forEach((key) => {
                    if (!seen.has(key)) { seen.add(key); names.push(key); }
                });
            }
        });
        return names;
    }

    // Looks for MMD's standard bone names (head/neck/eyes, Japanese and
    // common English variants). Returns null for anything not found so
    // gaze tracking can gracefully skip whichever parts aren't present -
    // plenty of models have a head bone but no separate eye bones, for
    // instance.
    function findBones(mesh) {
        const headNames = ['head', '頭'];
        const neckNames = ['neck', '首'];
        const eyeLNames = ['eye_l', 'eyel', 'lefteye', 'l_eye', '左目'];
        const eyeRNames = ['eye_r', 'eyer', 'righteye', 'r_eye', '右目'];
        const upperBodyNames = ['spine', 'chest', 'torso', 'body', 'upper', '胸', '上半身', '上身', '躯干'];

        let skeleton = null;
        mesh.traverse((child) => {
            if (!skeleton && child.isSkinnedMesh && child.skeleton) skeleton = child.skeleton;
        });
        if (!skeleton) return { head: null, neck: null, eyeL: null, eyeR: null, upperBody: null };

        let head = null, neck = null, eyeL = null, eyeR = null, upperBody = null;
        skeleton.bones.forEach((bone) => {
            const lower = (bone.name || '').toLowerCase();
            if (!head && headNames.some((n) => lower.includes(n.toLowerCase()))) head = bone;
            if (!neck && neckNames.some((n) => lower.includes(n.toLowerCase()))) neck = bone;
            if (!eyeL && eyeLNames.some((n) => lower.includes(n.toLowerCase()))) eyeL = bone;
            if (!eyeR && eyeRNames.some((n) => lower.includes(n.toLowerCase()))) eyeR = bone;
            if (!upperBody && upperBodyNames.some((n) => lower.includes(n.toLowerCase()))) upperBody = bone;
        });
        return { head, neck, eyeL, eyeR, upperBody };
    }

    // Turns whichever of head/neck/eye bones were found toward wherever the
    // cursor currently is on screen, relative to this instance's own
    // container - so an avatar tile in the corner of the screen looks
    // toward a cursor on the opposite side just like it would in real life.
    // No-ops (and settles back toward the bind pose) if tracking is off or
    // the model has none of these bones.
    function updateIdleMotion(delta) {
        if (!model) return;

        idleTime += delta;
        const idleHeadYaw = Math.sin(idleTime * 0.8) * CONFIG.idleHeadYawAmplitude;
        const idleHeadPitch = Math.sin(idleTime * 1.2 + 0.4) * CONFIG.idleHeadPitchAmplitude;
        const idleEyeYaw = Math.sin(idleTime * 1.1 + 0.3) * CONFIG.idleEyeYawAmplitude;
        const idleEyePitch = Math.sin(idleTime * 0.9 + 0.8) * CONFIG.idleEyePitchAmplitude;
        const idleUpperBodyYaw = Math.sin(idleTime * 0.65 + 0.25) * CONFIG.idleBodySwayAmplitude;
        const idleUpperBodyPitch = Math.sin(idleTime * 0.95 + 0.6) * CONFIG.idleBodyTiltAmplitude;

        return {
            idleHeadYaw,
            idleHeadPitch,
            idleEyeYaw,
            idleEyePitch,
            idleUpperBodyYaw,
            idleUpperBodyPitch,
        };
    }

    function updateGaze(delta) {
        if (!headBone && !neckBone && !eyeLBone && !eyeRBone) return;

        let targetHeadYaw = 0, targetHeadPitch = 0, targetEyeYaw = 0, targetEyePitch = 0;
        const idleMotion = updateIdleMotion(delta);
        const idleHeadYaw = idleMotion ? idleMotion.idleHeadYaw : 0;
        const idleHeadPitch = idleMotion ? idleMotion.idleHeadPitch : 0;
        const idleEyeYaw = idleMotion ? idleMotion.idleEyeYaw : 0;
        const idleEyePitch = idleMotion ? idleMotion.idleEyePitch : 0;
        const idleUpperBodyYaw = idleMotion ? idleMotion.idleUpperBodyYaw : 0;
        const idleUpperBodyPitch = idleMotion ? idleMotion.idleUpperBodyPitch : 0;

        if (remoteGazeDX !== null) {
            // Someone else's tile: use the direction they broadcast instead
            // of this browser's own cursor.
            targetHeadYaw = remoteGazeDX * CONFIG.headYawMax + idleHeadYaw * 0.35;
            targetHeadPitch = remoteGazeDY * CONFIG.headPitchMax + idleHeadPitch * 0.35;
            targetEyeYaw = remoteGazeDX * CONFIG.eyeYawMax + idleEyeYaw * 0.35;
            targetEyePitch = remoteGazeDY * CONFIG.eyePitchMax + idleEyePitch * 0.35;
        } else if (isLookAtCursorEnabled && !disposed) {
            const rect = container.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            let dx = (sharedCursor.x - cx) / (window.innerWidth / 2);
            let dy = (sharedCursor.y - cy) / (window.innerHeight / 2);
            dx = Math.max(-1, Math.min(1, dx));
            dy = Math.max(-1, Math.min(1, dy));
            lastCursorDX = dx;
            lastCursorDY = dy;

            targetHeadYaw = dx * CONFIG.headYawMax + idleHeadYaw * 0.2;
            targetHeadPitch = dy * CONFIG.headPitchMax + idleHeadPitch * 0.2;
            targetEyeYaw = dx * CONFIG.eyeYawMax + idleEyeYaw * 0.2;
            targetEyePitch = dy * CONFIG.eyePitchMax + idleEyePitch * 0.2;
        } else {
            lastCursorDX = 0;
            lastCursorDY = 0;
            targetHeadYaw = idleHeadYaw;
            targetHeadPitch = idleHeadPitch;
            targetEyeYaw = idleEyeYaw;
            targetEyePitch = idleEyePitch;
        }
        // else: targets stay 0, so the lerp below eases back to bind pose.

        // Frame-rate independent easing - reaches ~90% of the way to the
        // target in a few hundred ms regardless of refresh rate.
        const ease = 1 - Math.pow(0.001, delta);
        currentHeadYaw += (targetHeadYaw - currentHeadYaw) * ease;
        currentHeadPitch += (targetHeadPitch - currentHeadPitch) * ease;
        currentEyeYaw += (targetEyeYaw - currentEyeYaw) * ease;
        currentEyePitch += (targetEyePitch - currentEyePitch) * ease;

        if (headBone && headBind) {
            headBone.rotation.set(headBind.x + currentHeadPitch, headBind.y + currentHeadYaw, headBind.z);
        }
        if (neckBone && neckBind) {
            neckBone.rotation.set(
                neckBind.x + currentHeadPitch * CONFIG.neckFollow,
                neckBind.y + currentHeadYaw * CONFIG.neckFollow,
                neckBind.z
            );
        }
        if (eyeLBone && eyeLBind) {
            eyeLBone.rotation.set(eyeLBind.x + currentEyePitch, eyeLBind.y + currentEyeYaw, eyeLBind.z);
        }
        if (eyeRBone && eyeRBind) {
            eyeRBone.rotation.set(eyeRBind.x + currentEyePitch, eyeRBind.y + currentEyeYaw, eyeRBind.z);
        }
        if (upperBodyBone && upperBodyBind) {
            upperBodyBone.rotation.set(
                upperBodyBind.x + idleUpperBodyPitch * 0.4 + currentHeadPitch * 0.1,
                upperBodyBind.y + idleUpperBodyYaw * 0.4 + currentHeadYaw * 0.1,
                upperBodyBind.z
            );
        }
    }

    function applyMouth(amount) {
        const limited = Math.min(amount, CONFIG.mouthLimit);
        mouthKeys.forEach((k) => { k.inf[k.index] = Math.max(0, Math.min(1, limited)); });
    }

    function applyBlink(amount) {
        const limited = Math.min(amount, CONFIG.blinkIntensity);
        blinkKeys.forEach((k) => { k.inf[k.index] = Math.max(0, Math.min(1, limited)); });
    }

    function applySurprise(amount) {
        surpriseKeyGroups.forEach((group) => {
            group.keys.forEach((k) => {
                k.inf[k.index] = Math.max(0, Math.min(1, amount * group.intensity));
            });
        });
    }

    // In avatar3d.js, modify the loadModel function
    function loadModel() {
        const loader = new MMDLoader();
        
        // Use the model path directly - no setPath needed
        console.log('Loading model from:', modelUrl);
        
        loader.load(
            modelUrl,  // This should be the full path or relative path
            (mesh) => {
                if (disposed) return;
                console.log('✅ Model loaded successfully!', mesh);
                
                model = mesh;
                
                // Scale and position
                const targetHeight = 2.5;
                let currentHeight = 10.902268886566162;
                
                // Try to get actual height from bounding box
                try {
                    mesh.geometry.computeBoundingBox();
                    if (mesh.geometry.boundingBox) {
                        const box = mesh.geometry.boundingBox;
                        currentHeight = box.max.y - box.min.y;
                    }
                } catch (e) {}
                
                const scale = targetHeight / currentHeight;
                model.scale.set(scale, scale, scale);
                model.position.set(0, -0.5, 0);
                
                // Process materials - textures should load automatically.
                //
                // NOTE: `mat.map` being truthy only means a Texture object was
                // assigned - it does NOT mean the image behind it actually
                // loaded. If the underlying file 404s (e.g. a filename
                // encoding mismatch between what's on disk and what the PMX
                // references internally), `mat.map` stays a real, truthy
                // Texture pointing at a broken image, so this used to skip
                // the fallback tint entirely and just render black. We now
                // explicitly check whether the image behind the texture
                // loaded successfully, and also listen for late failures.
                function applyFallbackTint(mat) {
                    console.warn('⚠️ Texture failed to load, using fallback tint');
                    mat.map = null;
                    mat.color.setHex(0x88ccff);
                    mat.needsUpdate = true;
                }

                mesh.traverse((child) => {
                    if (child.isMesh) {
                        const materials = Array.isArray(child.material) ? child.material : [child.material];
                        materials.forEach(mat => {
                            if (mat.map) {
                                const img = mat.map.image;
                                const alreadyFailed = img && img.complete && img.naturalWidth === 0;

                                if (alreadyFailed) {
                                    applyFallbackTint(mat);
                                    return;
                                }

                                mat.map.encoding = THREE.sRGBEncoding;
                                mat.map.anisotropy = 4;
                                mat.map.needsUpdate = true;
                                mat.transparent = true;
                                mat.side = THREE.DoubleSide;
                                mat.needsUpdate = true;
                                console.log('✅ Texture found and applied');

                                // Image may still be in-flight (or may fail
                                // later than this synchronous check) - catch
                                // that case too.
                                if (img && !img.complete) {
                                    img.addEventListener('error', () => {
                                        if (disposed) return;
                                        applyFallbackTint(mat);
                                        renderer.render(scene, camera);
                                    }, { once: true });
                                }
                            } else {
                                console.warn('⚠️ No texture on mesh');
                                mat.color.setHex(0x88ccff);
                                mat.needsUpdate = true;
                            }
                        });
                    }
                });
                
                scene.add(model);
                
                const result = findShapeKeys(mesh, blinkShapeKeyNames, mouthShapeKeyNames, surpriseShapeKeySettings);
                mouthKeys = result.mouthKeys;
                blinkKeys = result.blinkKeys;
                surpriseKeyGroups = surpriseShapeKeySettings.map((entry) => {
                    const keys = [];
                    result.surpriseKeys.forEach((match) => {
                        if (match.name === entry.name) keys.push(match);
                    });
                    return { intensity: entry.intensity, keys };
                }).filter((group) => group.keys.length > 0);
                if (surpriseKeyGroups.length === 0 && result.surpriseKeys.length > 0) {
                    surpriseKeyGroups = [{ intensity: 1, keys: result.surpriseKeys }];
                }

                const bones = findBones(mesh);
                headBone = bones.head; neckBone = bones.neck; eyeLBone = bones.eyeL; eyeRBone = bones.eyeR; upperBodyBone = bones.upperBody;
                headBind = headBone ? headBone.rotation.clone() : null;
                neckBind = neckBone ? neckBone.rotation.clone() : null;
                eyeLBind = eyeLBone ? eyeLBone.rotation.clone() : null;
                eyeRBind = eyeRBone ? eyeRBone.rotation.clone() : null;
                upperBodyBind = upperBodyBone ? upperBodyBone.rotation.clone() : null;

                applyMouth(0);
                isReady = true;
                onReady({ shapeKeyNames: collectShapeKeyNames(mesh) });
                
                renderer.render(scene, camera);
            },
            (xhr) => {
                const progress = Math.round((xhr.loaded / xhr.total) * 100);
                console.log(`Loading progress: ${progress}%`);
            },
            (error) => {
                if (disposed) return;
                console.error('❌ Failed to load model:', error);
                console.error('File path:', modelUrl);
                onError(error);
            }
        );
    }

    function updateBlink(delta) {
        if (!isBlinkEnabled || blinkKeys.length === 0) {
            applyBlink(0);
            return;
        }
        if (!isBlinking) {
            if (blinkTimer <= 0) {
                blinkTimer = CONFIG.blinkIntervalMin + Math.random() * (CONFIG.blinkIntervalMax - CONFIG.blinkIntervalMin);
            }
            blinkTimer -= delta;
            if (blinkTimer <= 0) { isBlinking = true; blinkTimer = 0; }
        } else {
            const duration = 0.15;
            const elapsed = blinkTimer + delta;
            blinkTimer = elapsed;
            if (elapsed < duration * 0.4) {
                applyBlink(elapsed / (duration * 0.4));
            } else if (elapsed < duration * 0.6) {
                applyBlink(1);
            } else if (elapsed < duration) {
                applyBlink(1 - (elapsed - duration * 0.6) / (duration * 0.4));
            } else {
                isBlinking = false;
                blinkTimer = 0;
                applyBlink(0);
            }
        }
    }

    // voiceLevel is expected to be a 0-1 RMS-ish value (same scale voice.js
    // already computes for the speaking indicator).
    function updateMouth(voiceLevel, delta) {
        if (!isReady || mouthKeys.length === 0) return;

        const startNorm = CONFIG.startThreshold / 100;
        const maxNorm = CONFIG.maxThreshold / 100;
        const range = maxNorm - startNorm;

        // A start threshold at or past the max threshold (possible while
        // someone is mid-drag on the sliders) would otherwise divide by a
        // zero/negative range - just treat that as "never open" until the
        // values make sense again, rather than producing NaN/Infinity.
        if (range <= 0) {
            targetMouth = Math.max(targetMouth * 0.9, 0);
            applyMouth(targetMouth);
            return;
        }

        let mouthVal = 0;
        if (voiceLevel > startNorm) {
            mouthVal = (voiceLevel - startNorm) / range;
            mouthVal = Math.max(0, Math.min(1, mouthVal));
            mouthVal = mouthVal * mouthVal * (3 - 2 * mouthVal);
        }

        if (mouthVal > targetMouth) {
            targetMouth = Math.min(targetMouth + (mouthVal - targetMouth) * 0.5, 1);
        } else {
            targetMouth = Math.max(targetMouth * 0.9, mouthVal * 0.9);
        }

        applyMouth(targetMouth);
    }

    let pendingVoiceLevel = 0;

    function updateSurprise(delta) {
        if (!isReady || surpriseKeyGroups.length === 0) return;
        const target = mouseIsHeld ? 1 : 0;
        const ease = 1 - Math.pow(0.0005, delta);
        surpriseAmount += (target - surpriseAmount) * ease;
        applySurprise(surpriseAmount);
    }

    function loop() {
        if (disposed) return;
        rafId = requestAnimationFrame(loop);

        const now = performance.now();
        const delta = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        if (isReady) {
            updateBlink(delta);
            updateMouth(pendingVoiceLevel, delta);
            updateSurprise(delta);
            updateGaze(delta);
            if (autoRotateEnabled && model && CONFIG.autoRotateSpeed) {
                model.rotation.y = Math.sin(now / 4000) * 0.35;
            }
        }

        if (controls) controls.update();

        renderer.render(scene, camera);
    }

    const api = {
        setVoiceLevel(level) {
            pendingVoiceLevel = level || 0;
        },
        getFraming() {
            return { zoom, offsetX, offsetY, rotationY };
        },
        // Used by the zoom/rotate sliders / reset button - anything driving
        // framing outside of direct drag/scroll on the canvas itself.
        setFraming({ zoom: z, offsetX: ox, offsetY: oy, rotationY: ry } = {}) {
            if (z !== undefined) zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
            if (ox !== undefined) offsetX = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, ox));
            if (oy !== undefined) offsetY = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, oy));
            if (ry !== undefined) rotationY = ry;
            if (camera && baseTarget) {
                applyFraming();
                if (controls) controls.update();
                renderer.render(scene, camera);
            }
        },
        getLipSyncSettings() {
            return { mouthIntensity: CONFIG.mouthLimit, voiceStart: CONFIG.startThreshold, voiceMax: CONFIG.maxThreshold };
        },
        // Used by the lip-sync sliders in Edit Profile so dragging them
        // previews live against the mounted model, the same way
        // setFraming() does for zoom/rotate.
        setLipSyncSettings({ mouthIntensity, voiceStart, voiceMax } = {}) {
            if (mouthIntensity !== undefined) CONFIG.mouthLimit = clampMouthIntensity(mouthIntensity);
            if (voiceStart !== undefined) CONFIG.startThreshold = clampVoiceThreshold(voiceStart);
            if (voiceMax !== undefined) CONFIG.maxThreshold = clampVoiceThreshold(voiceMax);
        },
        getBlinkSettings() {
            return { blinkIntensity: CONFIG.blinkIntensity, blinkIntervalMin: CONFIG.blinkIntervalMin, blinkIntervalMax: CONFIG.blinkIntervalMax, blinkEnabled: isBlinkEnabled };
        },
        // Used by the blink sliders/toggle in Edit Profile so dragging them
        // previews live against the mounted model, same idea as
        // setLipSyncSettings(). Interval changes only take effect the next
        // time a wait is picked (i.e. after the blink in progress, or the
        // current wait, finishes) rather than retroactively.
        setBlinkSettings({ blinkIntensity, blinkIntervalMin, blinkIntervalMax, blinkEnabled } = {}) {
            if (blinkIntensity !== undefined) CONFIG.blinkIntensity = clampBlinkIntensity(blinkIntensity);
            if (blinkIntervalMin !== undefined) CONFIG.blinkIntervalMin = clampBlinkInterval(blinkIntervalMin);
            if (blinkIntervalMax !== undefined) CONFIG.blinkIntervalMax = clampBlinkInterval(blinkIntervalMax);
            if (blinkEnabled !== undefined) isBlinkEnabled = blinkEnabled;
        },
        toggleBlink(enabled) {
            isBlinkEnabled = enabled !== undefined ? enabled : !isBlinkEnabled;
        },
        getBlinkShapeKeys() {
            return blinkShapeKeyNames.slice();
        },
        // Used by the "Blink shape key(s)" field in Edit Profile so typing a
        // name previews live against the mounted model, same idea as
        // setBlinkSettings(). Passing an empty value goes back to
        // auto-detecting from the built-in name list. Any shape key(s)
        // this was previously driving are reset to 0 first so switching
        // away from one mid-blink doesn't leave an eye stuck shut.
        setBlinkShapeKeys(namesInput) {
            blinkShapeKeyNames = parseShapeKeyNames(namesInput);
            blinkKeys.forEach((k) => { k.inf[k.index] = 0; });
            blinkKeys = model ? findShapeKeys(model, blinkShapeKeyNames).blinkKeys : [];
        },
        getMouthShapeKeys() {
            return mouthShapeKeyNames.slice();
        },
        // Used by the "Mouth shape key(s)" field in Edit Profile so typing a
        // name previews live against the mounted model, same idea as
        // setBlinkShapeKeys(). Passing an empty value goes back to
        // auto-detecting from the built-in name list. Any shape key(s)
        // this was previously driving are reset to 0 first so switching
        // away from one mid-speech doesn't leave a mouth stuck open.
        setMouthShapeKeys(namesInput) {
            mouthShapeKeyNames = parseShapeKeyNames(namesInput);
            mouthKeys.forEach((k) => { k.inf[k.index] = 0; });
            mouthKeys = model ? findShapeKeys(model, blinkShapeKeyNames, mouthShapeKeyNames, surpriseShapeKeySettings).mouthKeys : [];
            targetMouth = 0;
        },
        getSurpriseShapeKeys() {
            return surpriseShapeKeySettings.slice();
        },
        setSurpriseShapeKeys(entriesInput) {
            surpriseShapeKeySettings = parseSurpriseShapeKeySettings(entriesInput);
            surpriseKeyGroups = [];
            if (model && surpriseShapeKeySettings.length > 0) {
                const result = findShapeKeys(model, blinkShapeKeyNames, mouthShapeKeyNames, surpriseShapeKeySettings);
                surpriseKeyGroups = surpriseShapeKeySettings.map((entry) => ({
                    intensity: entry.intensity,
                    keys: result.surpriseKeys.filter((match) => match.name === entry.name)
                })).filter((group) => group.keys.length > 0);
                if (surpriseKeyGroups.length === 0 && result.surpriseKeys.length > 0) {
                    surpriseKeyGroups = [{ intensity: 1, keys: result.surpriseKeys }];
                }
            }
            surpriseAmount = 0;
            applySurprise(0);
        },
        setMouseHoldSurprise(held) {
            mouseIsHeld = !!held;
        },
        // Every shape key name the currently-loaded model actually has,
        // so Edit Profile can show the user something to pick from rather
        // than having them guess (MMD models often use Japanese names).
        // Empty array if no model is loaded yet.
        getAvailableShapeKeyNames() {
            return model ? collectShapeKeyNames(model) : [];
        },
        getLookAtCursor() {
            return isLookAtCursorEnabled;
        },
        // Used by the "Look at cursor" toggle in Edit Profile. Turning it
        // off doesn't snap back to bind pose instantly - updateGaze() eases
        // there over the same lerp as normal tracking, which reads as a
        // calmer "settling" rather than a jump-cut.
        setLookAtCursor(enabled) {
            isLookAtCursorEnabled = !!enabled;
        },
        // Read back the direction this instance is currently looking, as
        // computed from the local cursor (only meaningful when
        // lookAtCursor is on and no remote override is set - e.g. the
        // local user's own voice tile). Used by voice.js to broadcast this
        // browser's gaze to other participants.
        getGazeDirection() {
            return { dx: lastCursorDX, dy: lastCursorDY };
        },
        // Feed in a direction received from another participant instead of
        // tracking this browser's own cursor - used for peers' voice
        // tiles. Pass null to go back to local-cursor tracking (or to
        // settle back to bind pose if that's off too).
        setRemoteGaze(gaze) {
            if (!gaze) { remoteGazeDX = null; remoteGazeDY = null; return; }
            const { dx, dy } = gaze;
            remoteGazeDX = Math.max(-1, Math.min(1, Number(dx) || 0));
            remoteGazeDY = Math.max(-1, Math.min(1, Number(dy) || 0));
        },
        resize() {
            const width = container.clientWidth || 96;
            const height = container.clientHeight || 96;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
        },
        dispose() {
            disposed = true;
            if (rafId) cancelAnimationFrame(rafId);
            if (controls) controls.dispose();
            container.removeEventListener('pointerdown', handlePointerDown);
            container.removeEventListener('pointerup', handlePointerUp);
            container.removeEventListener('pointerleave', handlePointerUp);
            if (renderer) {
                renderer.dispose();
                if (renderer.domElement && renderer.domElement.parentNode) {
                    renderer.domElement.parentNode.removeChild(renderer.domElement);
                }
            }
        }
    };

    const handlePointerDown = () => { mouseIsHeld = true; };
    const handlePointerUp = () => { mouseIsHeld = false; };
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointerup', handlePointerUp);
    container.addEventListener('pointerleave', handlePointerUp);

    initScene();
    loadModel();
    ensureCursorTracking();
    rafId = requestAnimationFrame(loop);

    return api;
}

window.Avatar3D = { createAvatar: createAvatar3D };