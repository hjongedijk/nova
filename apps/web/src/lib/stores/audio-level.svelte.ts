/**
 * How loud NOVA's own voice is right now. The shell's speaker writes it every animation frame
 * while NOVA speaks; the Stem panel draws its equaliser from it.
 *
 *   audioLevel.level    0..1, smoothed overall loudness (0 when silent)
 *   audioLevel.speaking true while NOVA is speaking
 *   audioLevel.bands    the analyser's byte frequency data (0..255 per bin), or null
 *                       when there is no analyser (then the panel fakes a wave from `level`)
 *
 * The accent colour of the equaliser and the charts is read from the --glow custom property on
 * <body>, which follows the entity's state, so nobody has to write a colour here.
 */
export const audioLevel = $state({
  level: 0,
  speaking: false,
  bands: null as Uint8Array | null,
});
