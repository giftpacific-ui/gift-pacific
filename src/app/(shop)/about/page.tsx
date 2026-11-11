import { permanentRedirect } from "next/navigation";

// The About page moved to /about-us; old links and bookmarks keep working.
export default function AboutRedirect() {
  permanentRedirect("/about-us");
}
