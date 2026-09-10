import type { ConversationMessage } from "../../src/domain/types.js";

// Retrospective of the five observed phases in the 2026-09-10 flight-game run.
// Paths and IDs are synthetic; tool results remain absent and the Team input
// preserves the truncated Team input. This is not a fresh owner execution.
export const TETO_FLIGHT_OBSERVATIONS: ReadonlyArray<{
  id: string;
  expectedSilence: boolean;
  message: Extract<ConversationMessage, { role: "user" | "assistant" }>;
}> = [
  {
    id: "initialRequest", expectedSilence: true,
    message: { role: "user", content: "帮我创建一个团队，改进下现有的index.html 这个飞行游戏，它有点粗糙", createdAt: "2026-09-10T18:41:25.072Z" },
  },
  {
    id: "inspectGame", expectedSilence: true,
    message: { role: "assistant", content: "I'll first inspect the existing `index.html` to understand the current flying game before creating a team.",
      toolCalls: [
        { id: "flight-list", name: "list_files", arguments: { path: ".", recursive: true } },
        { id: "flight-read", name: "read_file", arguments: { path: "index.html" } },
      ], createdAt: "2026-09-10T18:41:28.830Z" },
  },
  {
    id: "inspectArchitecture", expectedSilence: true,
    message: { role: "assistant", content: "I've reviewed the existing game. Let me also check the architecture.md for any context, then create the team",
      toolCalls: [{ id: "flight-architecture", name: "read_file", arguments: { path: "architecture.md" } }],
      createdAt: "2026-09-10T18:41:31.424Z" },
  },
  {
    id: "createTeam", expectedSilence: false,
    message: { role: "assistant", content: "I now have a full picture. The game is a complete three.js flight simulator that's functional but rough in several ways. I'll create a team to improve it in parallel across distinct areas",
      toolCalls: [{ id: "flight-create", name: "team_create", arguments: { members: [{
        input: "File: /workspace/index.html. It is a single-file three.js (UMD, global THREE) first-person flight sim. Key variables: CFG (physics constants), state (yaw/pitch/roll/speed/pos/displaySpeed), computeBasis(), updatePhysics(dt), updateCamera(), updateCockpit(). Camera uses perspective FOV 70. Euler order YXZ. Preserve gameState machine (menu/playing/paused). Post your result as a concise summary of exact edits.",
        memberId: "physics",
        statement: "Improve the flight physics and camera feel in index.html to make handling smoother and more immersive. Focus on: FOV that widens with speed for a sense of velocity, smoother roll interpolation, better pitch/yaw mouse sensitivity tuning, a subtle camera lag/parallax (camera slightly trails the aircraft orientation), and more natural gravity/lift model so climb/descent feels less rigid. Do NOT break existing collision, boundary, or HUD logic. Keep the game running and the controls working (W/S pitch, A/D yaw, Space thrust, Shift brake, mouse steering, pointer lock, Esc pause). Return the specific code changes you made as a diff-style description with line references.",
      }, {
        input: "File: /workspace/index.html. World is built via buildSky(), buildTerrain(), buildTrees(), buildClouds(), plus sun/hemi/ambient lights and a sun sprite. terrainHeight(x,z) is the deterministic noise function driving terrain; groundHeight() wraps it. CFG.cloudCount=60, treeCount=240. Clouds are Groups of spheres in a `clouds` array; trees are Groups in a `trees` group. scene.fog already set. Post concise summary of exact edits.",
        memberId: "world",
        statement: "Improve the visual richness of the world (terrain, sky, clouds, trees, lighting) in index.html so the scene looks more polished and less flat/rough. Ideas: add a second layer of low-altitude translucent clouds near flight altitude for 'flying through clouds' feel, add more terrain detail/slope variation, soften tree distribution (more natural clustering and color variety), improve sun/lighting and fog colors for a better time-of-day mood, and consider floating subtle particles or mist. Keep it single-file and performant (reuse materials/geometries, avoid per-frame allocations where easy). Do NOT change controls, physics, HUD, or menu logic. Return exact code changes as a summary.",
      }, {
        input: "File: /workspace/index.html. HUD is div#hud with #panel-speed, #panel-alt, #compass, #minimap-wrap, #feedback. Script exposes state.speed, state.displaySpeed, state.pos, state.yaw/pitch/roll, gameState. updateHUD() and updateCompass() run each frame. Menu is div#menu with .card, h1, .subtitle, .controls, button#btn-start. CSS uses variables like --hud-green, --hud-cyan, --hud-amber, --hud-red. Post concise summary of exact edits.",
        memberId: "hud",
        statement: "Polish the HUD, feedback, and menu UI of index.html to look more professional and readable. Improve the speed/altitude panels (units, throttle indicator), add a pitch/roll attitude indicator or climb-rate (vertical speed) readout, refine compass styling/behavior, style the collision/boundary warning with a smoother fade, improve the pause/start menu layout and add a small controls legend with visual consistency, and add a subtle on-screen speed-lines/vignette overlay for immersion. Keep pointer-events correct (HUD pointer-events none, menu clickable). Do NOT touch three.js scene, physics, or state logic except reading values already exposed. Return exact changes.",
      }, {
        input: "Wait to be assigned after physics, world, and hud have reported. File to inspect: /workspace/index.html. Check for: broken JS, undeclared variables causing errors, HUD/pointer-events conflicts, regressions in collision/boundary/pause logic, and consistency between the three changes. Report findings clearly.",
        memberId: "reviewer",
        statement: "Review the combined improvements to index.html after the other members finish, verify the game still runs and controls work, and report any bugs or regressions. This is a review-only task; do not modify files.",
      }], teamId: "flight-polish" } }], createdAt: "2026-09-10T18:41:51.624Z" },
  },
  {
    id: "waitForResults", expectedSilence: false,
    message: { role: "assistant", content: "I've already created the team with three parallel workers + a reviewer, each scoped to non-overlapping parts of the file (physics/camera vs world visuals vs HUD/menu) to minimize merge conflicts, with the reviewer last to catch integration issues. Let me wait for the first results. I'll use `task_wait` on each task as they complete.",
      toolCalls: [{ id: "flight-wait", name: "task_wait", arguments: { taskId: "flight-polish:physics", teamId: "flight-polish" } }],
      createdAt: "2026-09-10T18:42:01.151Z" },
  },
];
