export const matcher = '/api/*';
export async function loadTarget() {
  const m = await import('./target');
  return m;
}
/** Doc comment that closes here. */
export const x = 1;
