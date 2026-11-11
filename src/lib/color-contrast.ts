/**
 * Returns "#000000" or "#ffffff", whichever gives better WCAG contrast
 * against the given hex background color. Used to keep
 * --primary-foreground/--secondary-foreground readable no matter what
 * color an admin picks in settings, instead of assuming white always
 * works (it doesn't, for light admin-chosen colors).
 */
export function readableForeground(hex: string): "#000000" | "#ffffff" {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return "#ffffff";

  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const linearize = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;

  return contrastWithBlack > contrastWithWhite ? "#000000" : "#ffffff";
}
