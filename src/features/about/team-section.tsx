import Image from "next/image";
import type { PublicTeamMember } from "@/server/services/team.service";

/** Renders nothing when there are no published members — never placeholder people. */
export function TeamSection({ title, members }: { title: string; members: PublicTeamMember[] }) {
  if (members.length === 0) return null;
  return (
    <section aria-labelledby={`team-${title}`} className="space-y-6">
      <h2 id={`team-${title}`} className="text-center font-heading text-2xl font-semibold text-foreground">
        {title}
      </h2>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => (
          <li key={m.id} className="overflow-hidden rounded-[4px] border border-border bg-card">
            {m.imageUrl ? (
              <div className="relative aspect-[4/5] bg-secondary">
                <Image src={m.imageUrl} alt={m.name} fill sizes="(min-width:1024px) 33vw, (min-width:640px) 50vw, 100vw" className="object-cover" />
              </div>
            ) : (
              <div className="grid aspect-[4/5] place-items-center bg-secondary font-heading text-5xl text-muted-foreground" aria-hidden>
                {m.name.charAt(0)}
              </div>
            )}
            <div className="space-y-1 p-5">
              <h3 className="font-heading text-lg font-semibold">{m.name}</h3>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">{m.designation}</p>
              {m.bio && <p className="pt-2 text-sm leading-relaxed text-muted-foreground">{m.bio}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
