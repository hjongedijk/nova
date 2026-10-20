/** Shared masks keep the moving figure separate from the stationary scenery. */
export const projectionShading = `
  float figureCoverage(vec2 uv) {
    vec2 p = uv - 0.5;
    float width = mix(0.55, 0.16, smoothstep(-0.30, -0.16, p.y));
    width = mix(width, 0.215, smoothstep(-0.16, -0.04, p.y));
    width -= 0.08 * smoothstep(0.28, 0.48, p.y);
    return 1.0 - smoothstep(width - 0.012, width + 0.018, abs(p.x));
  }
  vec3 tintProjection(vec3 color, vec3 tint, float amount) {
    float energy = max(color.r, max(color.g, color.b));
    return mix(color, tint * energy, amount);
  }
`;
