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
    <span class="companion-star">✦</span>
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
    width: 82px;
    height: 66px;
    border-radius: 26px 25px 24px 29px;
    background: linear-gradient(145deg, #f2fcff, #b9e8f1 68%, #8fc5d9);
    box-shadow:
      inset 0 2px 1px #ffffffb3,
      inset 0 -3px 8px #5fadc333,
      0 9px 22px #0005;
    transform: rotate(-5deg);
    transition:
      transform 0.3s ease,
      background 0.3s ease;
  }
  .companion-star {
    position: absolute;
    left: 10px;
    top: 5px;
    color: #469eb5;
    font:
      12px/1 system-ui,
      sans-serif;
  }
  .companion-face {
    position: absolute;
    inset: 23px 0 12px;
    display: flex;
    justify-content: center;
    gap: 16px;
    transform: translate(var(--gaze-x), var(--gaze-y));
    transition: transform 0.12s ease-out;
  }
  .eye {
    width: 6px;
    height: 11px;
    border-radius: 50%;
    background: #183a48;
    box-shadow: inset 1px 1px 1px #ffffff24;
    animation: blink 7s infinite;
  }
  .mouth {
    position: absolute;
    top: 16px;
    left: calc(50% - 4px);
    width: 8px;
    height: 4px;
    border-bottom: 2px solid #397184;
    border-radius: 0 0 8px 8px;
  }
  .companion-shadow {
    position: absolute;
    z-index: -1;
    bottom: 6px;
    width: 64px;
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
    box-shadow:
      inset 0 2px 1px #ffffffb3,
      0 0 22px #8adcec26;
  }
  [data-state="speaking"] .mouth {
    height: calc(4px + var(--level, 0) * 8px);
    border: 0;
    background: #397184;
    border-radius: 50%;
  }
  [data-state="error"] .companion-body {
    background: linear-gradient(145deg, #fff6e9, #f3cfb5);
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
    transform: scale(0.34) rotate(-5deg);
    flex: none;
  }
  .compact .companion-shadow {
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
