<script lang="ts">
  let {
    state: mood = "ready",
    compact = false,
  }: { state?: string; compact?: boolean } = $props();
  let face: HTMLDivElement;
  let gaze = $state({ x: 0, y: 0 });
  function follow(event: PointerEvent) {
    if (!face) return;
    const box = face.getBoundingClientRect();
    gaze = {
      x: Math.max(
        -3,
        Math.min(3, (event.clientX - box.x - box.width / 2) / 35),
      ),
      y: Math.max(
        -2,
        Math.min(2, (event.clientY - box.y - box.height / 2) / 35),
      ),
    };
  }
</script>

<svelte:window onpointermove={follow} onblur={() => (gaze = { x: 0, y: 0 })} />
<div
  class="nova-companion"
  class:compact
  data-state={mood}
  aria-hidden="true"
  style:--gaze-x={`${gaze.x}px`}
  style:--gaze-y={`${gaze.y}px`}
>
  <div class="companion-body" bind:this={face}>
    <span class="companion-arm arm-left"></span>
    <span class="companion-arm arm-right"></span>
    <span class="companion-suit"></span>
    <span class="companion-orbit"></span>
    <span class="companion-helmet"></span>
    <div class="companion-face">
      <i class="eye"></i><i class="eye"></i>
      <span class="mouth"></span>
    </div>
  </div>
  <span class="companion-shadow"></span>
</div>

<style>
  .nova-companion {
    position: relative;
    display: grid;
    place-items: center;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    flex: none;
    width: 112px;
    height: 104px;
    isolation: isolate;
  }
  .companion-body {
    position: relative;
    width: 88px;
    height: 94px;
    color: #c2edff;
    transform: rotate(-4deg);
    transition:
      transform 0.3s ease,
      color 0.3s ease;
  }
  .companion-helmet {
    position: absolute;
    z-index: 2;
    top: 2px;
    left: 12px;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: radial-gradient(
      circle at 32% 22%,
      #fff 0,
      #e5faff 25%,
      currentColor 65%,
      #79badb 100%
    );
    box-shadow:
      inset 0 1px 1px #fff,
      0 5px 10px #071b3540;
  }
  .companion-suit {
    position: absolute;
    left: 26px;
    top: 57px;
    width: 36px;
    height: 32px;
    border-radius: 12px 12px 18px 18px;
    background: linear-gradient(125deg, #e5faff, currentColor 55%, #82bad9);
    clip-path: polygon(0 0, 100% 0, 85% 100%, 15% 100%);
  }
  .companion-suit::after {
    content: "";
    position: absolute;
    width: 7px;
    height: 7px;
    left: calc(50% - 3.5px);
    top: 13px;
    border-radius: 50%;
    background: #198cb8;
    box-shadow: 0 0 0 3px #93e6ff;
  }
  .companion-arm {
    position: absolute;
    top: 59px;
    width: 13px;
    height: 24px;
    border-radius: 50%;
    background: linear-gradient(90deg, #e5faff, currentColor);
  }
  .arm-left {
    left: 14px;
    transform: rotate(28deg);
  }
  .arm-right {
    right: 14px;
    transform: rotate(-28deg);
  }
  .companion-orbit {
    position: absolute;
    z-index: 3;
    left: 16px;
    top: 70px;
    width: 56px;
    height: 13px;
    border: 1.5px solid #67c9ed;
    border-radius: 50%;
    transform: rotate(-18deg);
    box-sizing: border-box;
    pointer-events: none;
  }
  .companion-face {
    position: absolute;
    top: 23px;
    left: 21px;
    width: 46px;
    height: 30px;
    padding-top: 8px;
    box-sizing: border-box;
    border-radius: 48%;
    background: linear-gradient(145deg, #193c5c, #0e2139);
    box-shadow: inset 0 1px 2px #0005;
    z-index: 3;
    display: flex;
    justify-content: center;
    gap: 12px;
    transform: translate(var(--gaze-x), var(--gaze-y));
    transition: transform 0.12s ease-out;
  }
  .eye {
    width: 6px;
    height: 11px;
    border-radius: 50%;
    background: #c2f5ff;
    box-shadow: inset 1px 1px 1px #ffffff24;
    animation: blink 7s infinite;
  }
  .mouth {
    position: absolute;
    top: 21px;
    left: calc(50% - 4px);
    width: 8px;
    height: 4px;
    border-bottom: 1.5px solid #a4e4f5;
    border-radius: 0 0 8px 8px;
  }
  .companion-shadow {
    position: absolute;
    z-index: -1;
    bottom: 0;
    width: 48px;
    height: 8px;
    border-radius: 50%;
    background: #0004;
    filter: blur(3px);
  }
  [data-state="thinking"] .companion-body {
    animation: ponder 2s ease-in-out infinite;
  }
  [data-state="listening"] .companion-body {
    transform: rotate(4deg) translateY(-3px);
    color: #dffaff;
  }
  [data-state="listening"] .companion-orbit {
    border-color: #b7f3ff;
  }
  [data-state="speaking"] .mouth {
    height: calc(4px + var(--level, 0) * 8px);
    border: 0;
    background: #a4e4f5;
    border-radius: 50%;
  }
  [data-state="error"] .companion-body {
    color: #f1d8bf;
  }
  [data-state="error"] .mouth {
    transform: rotate(180deg);
  }
  .compact {
    width: 32px;
    height: 30px;
  }
  .compact .companion-body {
    animation: none;
    transform: scale(0.44) rotate(-4deg) translateY(14px);
    flex: none;
  }
  .compact .companion-shadow,
  .compact .companion-suit,
  .compact .companion-arm,
  .compact .companion-orbit {
    display: none;
  }
  @keyframes blink {
    0%,
    91%,
    96%,
    100% {
      transform: scaleY(1);
    }
    93%,
    94% {
      transform: scaleY(0.15);
    }
  }
  @keyframes ponder {
    0%,
    100% {
      transform: rotate(-5deg) translateY(0);
    }
    50% {
      transform: rotate(3deg) translateY(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .companion-body,
    .companion-face,
    .eye {
      animation: none !important;
      transition: none;
    }
  }
</style>
