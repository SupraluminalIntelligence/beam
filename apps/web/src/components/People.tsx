import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { hueClass } from "../lib/format";
import { PersonAvatar } from "./Avatar";
import type { Me, ModalKind } from "./Shell";

type Runner = { ownerLogin: string; name: string; online: boolean };
/**
 * Who is in the workspace, as avatar chips in the title bar: online people first and bright, away people dimmed.
 * Click for the list with presence and runners, and to invite.
 */
export function People({ me, members, presence, runners, setModal }: { me: Me; members: string[]; presence: { login: string; chatId: Id<"chats"> | null }[]; runners: Runner[]; setModal: (m: ModalKind) => void }) {
  const people = useQuery(api.users.byLogins, { logins: members });
  const [open, setOpen] = useState(false);
  useEffect(() => { const close = () => setOpen(false); document.addEventListener("click", close); return () => document.removeEventListener("click", close); }, []);
  const online = (l: string) => l === me.githubLogin || presence.some((x) => x.login === l);
  const nameOf = (l: string) => (l === me.githubLogin ? me.name : people?.[l]?.name ?? l);
  const imageOf = (l: string) => (l === me.githubLogin ? me.image : people?.[l]?.image ?? null);
  const runnersOf = (l: string) => runners.filter((r) => r.online && r.ownerLogin === l).map((r) => r.name);
  const sorted = [...members].sort((a, b) => Number(online(b)) - Number(online(a)) || a.localeCompare(b));
  const shown = sorted.slice(0, 6), extra = sorted.length - shown.length;
  return (
    <div className="people" onClick={(e) => e.stopPropagation()}>
      <button className="pp-chips" onClick={() => setOpen(!open)} title={`${members.length} ${members.length === 1 ? "person" : "people"} · ${sorted.filter(online).length} online`}>
        {shown.map((l) => <span key={l} className={`pp-chip${online(l) ? "" : " away"}`}><PersonAvatar login={l} name={nameOf(l)} image={imageOf(l)} hue={l === me.githubLogin ? "me" : hueClass(l)} className="xs" /></span>)}
        {extra > 0 && <span className="pp-more">+{extra}</span>}
        <span className="pp-add">+</span>
      </button>
      <div className="pp-pop" hidden={!open}>
        <div className="ph">People · {sorted.filter(online).length} online</div>
        {sorted.map((l) => {
          const rs = runnersOf(l);
          return (
            <div key={l} className="pp-row">
              <PersonAvatar login={l} name={nameOf(l)} image={imageOf(l)} hue={l === me.githubLogin ? "me" : hueClass(l)} />
              <div className="pp-identity">
                <span className="nm" title={nameOf(l)}>{nameOf(l)}{l === me.githubLogin && <span className="k"> you</span>}</span>
                <span className="d" title={rs.join(", ") || undefined}>{online(l) ? "online" : "away"}{rs.length ? ` · ${rs.join(", ")}` : ""}</span>
              </div>
              <span className={`sq ${online(l) ? "ok" : "idle"}`} />
            </div>
          );
        })}
        <button className="pp-invite" onClick={() => { setOpen(false); setModal({ kind: "invite" }); }}><span className="av plus">+</span><span>Invite someone by GitHub login</span></button>
      </div>
    </div>
  );
}
