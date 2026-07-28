// background3d.js - Renders public/background/comic_empty.glb as ambient
// decor behind the "empty state" screen (shown when no friend DM or group
// channel is selected yet). Self-contained, no exports needed - nothing
// else talks to it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

(function initEmptyStateBackground() {
    const container = document.getElementById('empty-state');
    if (!container) return;

    // A dedicated absolutely-positioned layer behind .empty-icon, so the
    // canvas doesn't participate in the empty-state's centered flex layout
    // and never intercepts clicks.
    const canvasHost = document.createElement('div');
    canvasHost.className = 'empty-state-3d';
    container.insertBefore(canvasHost, container.firstChild);

    let scene, camera, renderer, model, mixer;
    let started = false;
    let disposed = false;
    let rafId = null;
    const clock = new THREE.Clock();

    // How far the model tilts toward the cursor, in radians - kept small
    // so it reads as a subtle parallax tilt, not a spin. Yaw is asymmetric:
    // more range to the left (more noticeable), less to the right, and a
    // small BASE_YAW so the model always looks slightly toward the cursor
    // side rather than sitting dead-center by default.
    const MAX_YAW_RIGHT = 0.06;
    const MAX_YAW_LEFT = 0.16;
    const BASE_YAW = 0.05;
    const MAX_PITCH = 0.1;
    const DAMPING = 0.06; // lower = smoother/slower catch-up to the cursor

    // How much of the camera's vertical field of view the model's height
    // should fill. 1.0 = touches the very top/bottom edges of the canvas;
    // slightly under 1 leaves a bit of breathing room.
    const FILL_FACTOR = 1;

    // Horizontal/vertical offsets applied after centering, in the same
    // world units as the model's scaled size. Positive X = right, negative
    // X = left. Positive Y = up, negative Y = down.
    const X_OFFSET = 0.9;
    const Y_OFFSET = 0;

    let targetYaw = 0;
    let targetPitch = 0;
    let currentYaw = 0;
    let currentPitch = 0;

    // Tracked page-wide (not just over the canvas) so the model keeps
    // gently responding even while the cursor is elsewhere on screen -
    // same idea as a portrait that "watches" you. Normalized against the
    // canvas container's own bounding box (not the window), so "centered"
    // means centered over the model itself, not the middle of the screen.
    window.addEventListener('mousemove', (e) => {
        const rect = canvasHost.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const { cx, cy } = getModelScreenCenter(rect);

        const nx = (e.clientX - cx) / (rect.width / 2);
        const ny = (e.clientY - cy) / (rect.height / 2);

        targetYaw = BASE_YAW + (nx >= 0 ? nx * MAX_YAW_RIGHT : nx * MAX_YAW_LEFT);
        targetPitch = ny * MAX_PITCH;
    }, { passive: true });

    function render() {
        if (disposed || !renderer) return;
        renderer.render(scene, camera);
    }

    // Projects the model's actual world-space position through the camera
    // to find where it lands on screen (in page pixel coords). This is the
    // true visual center of the model - not the center of canvasHost's div,
    // which can differ once X_OFFSET/Y_OFFSET and perspective are involved.
    function getModelScreenCenter(rect) {
        if (!model || !camera) {
            return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
        }
        const ndc = model.position.clone().project(camera);
        const cx = rect.left + (ndc.x * 0.5 + 0.5) * rect.width;
        const cy = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height;
        return { cx, cy };
    }

    function initScene(width, height) {
        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.position.set(0, 1.1, 4.2);
        camera.lookAt(0, 0, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        canvasHost.appendChild(renderer.domElement);

        const ambient = new THREE.AmbientLight(0xffffff, 1.1);
        scene.add(ambient);
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(3, 5, 4);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xaaccff, 0.5);
        fill.position.set(-4, 2, -3);
        scene.add(fill);

        new GLTFLoader().load(
            '/background/comic_empty.glb',
            (gltf) => {
                if (disposed) return;
                model = gltf.scene;

                // Re-center, then scale so the model's height fills the
                // camera's vertical field of view (i.e. the full height of
                // the canvas), regardless of the model's native size.
                // Vertical FOV is constant across resizes/aspect ratios, so
                // this only needs to be computed once, here, at load time -
                // it doesn't need to be recalculated on resize.
                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                const center = box.getCenter(new THREE.Vector3());

                const distance = camera.position.distanceTo(center);
                const vFovRad = THREE.MathUtils.degToRad(camera.fov);
                const visibleHeight = 2 * distance * Math.tan(vFovRad / 2);
                const scale = (visibleHeight * FILL_FACTOR) / (size.y || 1);

                model.scale.setScalar(scale);
                model.position.sub(center.multiplyScalar(scale));
                model.position.x += X_OFFSET;
                model.position.y += Y_OFFSET;

                scene.add(model);

                // Play back whatever animation clips came baked into the
                // GLB (idle loops, etc). Without a mixer, clips load but
                // never advance - the model stays on frame 0 forever.
                if (gltf.animations && gltf.animations.length) {
                    mixer = new THREE.AnimationMixer(model);
                    gltf.animations.forEach((clip) => {
                        mixer.clipAction(clip).play();
                    });
                }

                render();
            },
            undefined,
            (err) => {
                console.warn('Could not load empty-state background model:', err);
            }
        );

        render();
        loop();
    }

    function loop() {
        if (disposed) return;
        rafId = requestAnimationFrame(loop);

        // Skip work while the empty state itself is hidden (e.g. a chat is
        // currently open) - cheap check, avoids wasted GPU work.
        if (canvasHost.offsetWidth === 0 || canvasHost.offsetHeight === 0) return;

        const delta = clock.getDelta();
        if (mixer) mixer.update(delta);

        currentYaw += (targetYaw - currentYaw) * DAMPING;
        currentPitch += (targetPitch - currentPitch) * DAMPING;

        if (model) {
            model.rotation.y = currentYaw;
            model.rotation.x = currentPitch;
        }
        render();
    }

    const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width < 10 || height < 10) return; // still hidden/collapsed

        if (!started) {
            started = true;
            initScene(width, height);
            return;
        }
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        render();
    });
    observer.observe(canvasHost);

    window.addEventListener('beforeunload', () => {
        disposed = true;
        if (rafId) cancelAnimationFrame(rafId);
        observer.disconnect();
        if (renderer) renderer.dispose();
    });
})();