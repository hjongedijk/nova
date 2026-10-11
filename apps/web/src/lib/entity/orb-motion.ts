/** A short, subtle glance every twelve seconds while the orb is otherwise idle. */
export function idleGlance(seconds: number): { x: number; y: number } {
  const cycle = Math.floor(seconds / 12);
  const phase = seconds - cycle * 12;
  if (phase < 0.15 || phase > 0.85) return { x: 0, y: 0 };
  const directions = [
    { x: 1, y: -0.35 },
    { x: -0.8, y: 0.55 },
    { x: 0.45, y: 1 },
    { x: -1, y: -0.25 },
  ];
  const direction = directions[cycle % directions.length]!;
  const strength = Math.sin(((phase - 0.15) / 0.7) * Math.PI) * 0.16;
  return { x: direction.x * strength, y: direction.y * strength };
}
