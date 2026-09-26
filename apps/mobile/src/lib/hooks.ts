import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "./convex";

/** A clock that ticks only while something is live. */
export function useNow(active: boolean, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), every); return () => clearInterval(id); }, [active, every]);
  return now;
}

export function useMe() {
  return useQuery(api.users.me) ?? null;
}

/** Display names and GitHub avatars for a set of logins. */
export function usePeople(logins: string[]) {
  const people = useQuery(api.users.byLogins, logins.length ? { logins: [...new Set(logins)].sort() } : "skip");
  return {
    nameOf: (l: string) => people?.[l]?.name ?? l,
    imageOf: (l: string) => people?.[l]?.image ?? null,
  };
}
