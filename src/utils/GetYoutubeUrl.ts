
export function extractYouTubeId(
  url: string | null | undefined,
): string | null {
  if (!url) return null;

  // Pattern handles: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID, youtube.com/embed/ID
  const regExp =
    /^.*(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);

  return match && match[1].length === 11 ? match[1] : null;
}

// ২. প্রোডাক্ট কার্ডের (Hover Autoplay) জন্য Embed URL
export function getYouTubeCardEmbedUrl(
  url: string | null | undefined,
): string | null {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&controls=0&loop=1&playlist=${videoId}`;
}

// ৩. প্রোডাক্ট ডিটেইল/গ্যালারির (Main Player) জন্য Embed URL
export function getYouTubeGalleryEmbedUrl(
  url: string | null | undefined,
): string | null {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
}
