export type Vec3 = [number, number, number];

export const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const formatDistance = (value: number, units?: string): string => {
  const digits = value >= 100 ? 1 : value >= 1 ? 2 : 3;
  return `${new Intl.NumberFormat("nl-NL", { maximumFractionDigits: digits }).format(value)} ${units || "eenheden"}`;
};
